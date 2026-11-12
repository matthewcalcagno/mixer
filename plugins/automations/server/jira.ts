import { z } from "zod";

const baseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "Jira baseUrl must use HTTPS (HTTP is allowed for localhost), without credentials, query, or fragment");

const requestSettings = {
  requestTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  pageSize: z.number().int().min(1).max(1_000).default(50),
};
export const connectionSchema = z
  .object({
    baseUrl: baseUrlSchema.transform((value) => value.replace(/\/+$/, "")),
    token: z.string().min(1),
    ...requestSettings,
  })
  .strict();
export const configSchema = z.union([connectionSchema, z.object(requestSettings).strict()]);

const updatedSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid Jira updated timestamp");
export const issueSchema = z.object({
  id: z.string().regex(/^\d+$/),
  key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  fields: z.object({ summary: z.string(), updated: updatedSchema }).catchall(z.json()),
});
const searchSchema = z.object({
  startAt: z.number().int().nonnegative(),
  maxResults: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  issues: z.array(issueSchema),
  names: z.record(z.string(), z.string()).optional(),
});

export class JiraClient {
  constructor(private readonly config: z.infer<typeof connectionSchema>) {}

  browseUrl(key: string): string {
    return `${this.config.baseUrl}/browse/${encodeURIComponent(key)}`;
  }

  async search(options: {
    jql: string;
    fields: string[];
    startAt?: number;
    maxResults?: number;
    signal?: AbortSignal;
  }) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.config.requestTimeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/rest/api/2/search`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jql: options.jql,
          fields: options.fields,
          expand: ["names"],
          startAt: options.startAt ?? 0,
          maxResults: options.maxResults ?? this.config.pageSize,
        }),
      });
    } catch {
      throw new Error(
        options.signal?.aborted
          ? "Jira request cancelled"
          : "Jira request failed, timed out, or redirected; check connectivity and baseUrl",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Jira search returned HTTP ${response.status}; check authentication, permissions, and JQL`,
      );
    }
    try {
      return searchSchema.parse(await response.json());
    } catch {
      throw new Error(
        "Jira search returned an invalid response; expected REST v2 search JSON with issue summary and updated fields",
      );
    }
  }
}
