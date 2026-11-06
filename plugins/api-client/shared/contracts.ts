import { defineRpc } from "@mixer/plugin";
import { z } from "zod";

export const MAX_VARIABLES_PER_SCOPE = 200;
// Globals, collection, and selected environment are merged without discarding scope precedence.
export const MAX_REQUEST_VARIABLES = MAX_VARIABLES_PER_SCOPE * 3;

export const pairSchema = z.object({
  id: z.string(),
  key: z.string().max(8192),
  value: z.string().max(1_000_000),
  enabled: z.boolean(),
});
export type Pair = z.infer<typeof pairSchema>;
export const fileSchema = z.object({
  name: z.string().max(1024),
  mimeType: z.string().max(256),
  base64: z.string().max(3_000_000),
});
export const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().max(8192) }),
  z.object({
    type: z.literal("basic"),
    username: z.string().max(8192),
    password: z.string().max(8192),
  }),
  z.object({
    type: z.literal("api-key"),
    key: z.string().max(8192),
    value: z.string().max(8192),
    location: z.enum(["header", "query"]),
  }),
]);
export const requestSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(256),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  url: z.string().max(16384),
  params: z.array(pairSchema).max(200),
  headers: z.array(pairSchema).max(200),
  auth: authSchema,
  body: z.object({
    type: z.enum(["none", "json", "text", "urlencoded", "multipart", "binary"]),
    rawFormat: z.enum(["text", "javascript", "json", "html", "xml"]).optional(),
    text: z.string().max(2_000_000),
    fields: z.array(pairSchema.extend({ file: fileSchema.optional() })).max(100),
    file: fileSchema.nullable(),
  }),
  timeoutMs: z.number().int().min(100).max(120000),
  followRedirects: z.boolean(),
  maxRedirects: z.number().int().min(0).max(20).optional(),
  followOriginalMethod: z.boolean().optional(),
  forwardAuthorization: z.boolean().optional(),
  removeReferer: z.boolean().optional(),
  disableCookieJar: z.boolean().optional(),
});
export type ApiRequest = z.infer<typeof requestSchema>;
export type RequestFile = z.infer<typeof fileSchema>;
export const environmentSchema = z.object({
  id: z.string(),
  name: z.string().max(128),
  variables: z.array(pairSchema).max(MAX_VARIABLES_PER_SCOPE),
});
export type Environment = z.infer<typeof environmentSchema>;
export const responseSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  url: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  cookies: z.array(z.string()),
  cookieJar: z.string(),
  cookieUpdates: z.array(z.object({ url: z.string(), value: z.string() })),
  body: z.string(),
  encoding: z.enum(["text", "base64"]),
  contentType: z.string(),
  bytes: z.number(),
  durationMs: z.number(),
  truncated: z.boolean(),
  redirects: z.array(z.object({ status: z.number(), url: z.string() })),
});
export type ApiResponse = z.infer<typeof responseSchema>;
export const sendRpc = defineRpc({
  name: "http.send",
  input: z.object({
    requestId: z.string().uuid(),
    request: requestSchema,
    variables: z.array(pairSchema).max(MAX_REQUEST_VARIABLES),
    cookieJar: z.string().max(250000),
  }),
  output: z.object({ started: z.boolean() }),
});
export const cancelRpc = defineRpc({
  name: "http.cancel",
  input: z.object({ requestId: z.string().uuid() }),
  output: z.object({ cancelled: z.boolean() }),
});

export const resultRpc = defineRpc({
  name: "http.result",
  input: z.object({ requestId: z.string().uuid() }),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("pending") }),
    z.object({ state: z.literal("complete"), response: responseSchema }),
    z.object({ state: z.literal("error"), error: z.string() }),
  ]),
});
