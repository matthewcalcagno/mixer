import { z } from "zod";
import { requestSchema, type ApiRequest } from "../shared/contracts.js";
import { requestParams, splitRequestUrl } from "../shared/query.js";
import { rawContentType } from "../shared/headers.js";
import { newPair, newRequest } from "../shared/request.js";
import { cloneCollection } from "./collection-model.js";
import { collectionSchema, type Collection } from "./model.js";

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function appendCurlBody(request: ApiRequest, args: string[]) {
  if (request.body.type === "json" || request.body.type === "text") {
    if (
      !request.headers.some(
        (header) => header.enabled && header.key.toLowerCase() === "content-type",
      )
    )
      args.push("--header", quote(`Content-Type: ${rawContentType(request.body)}`));
    args.push("--data-raw", quote(request.body.text));
  }
  if (request.body.type === "urlencoded" || request.body.type === "multipart") {
    for (const pair of request.body.fields) {
      if (pair.enabled && pair.key)
        args.push(
          request.body.type === "multipart" ? "--form" : "--data-urlencode",
          quote(`${pair.key}=${pair.file ? `@${pair.file.name}` : pair.value}`),
        );
    }
  }
  if (request.body.type === "binary" && request.body.file)
    args.push("--data-binary", quote(`@${request.body.file.name}`));
}
export function toCurl(request: ApiRequest): string {
  const { base, fragment } = splitRequestUrl(request.url);
  const args = ["curl", "--request", request.method, quote(`${base}${fragment}`)];
  for (const pair of requestParams(request)) {
    if (pair.enabled && pair.key) args.push("--url-query", quote(`${pair.key}=${pair.value}`));
  }
  for (const pair of request.headers) {
    if (pair.enabled && pair.key) args.push("--header", quote(`${pair.key}: ${pair.value}`));
  }
  if (request.auth.type === "bearer")
    args.push("--header", quote(`Authorization: Bearer ${request.auth.token}`));
  if (request.auth.type === "basic")
    args.push("--user", quote(`${request.auth.username}:${request.auth.password}`));
  if (request.auth.type === "api-key") {
    args.push(
      request.auth.location === "header" ? "--header" : "--url-query",
      quote(
        `${request.auth.key}${request.auth.location === "header" ? ": " : "="}${request.auth.value}`,
      ),
    );
  }
  appendCurlBody(request, args);
  if (request.followRedirects) args.push("--location");
  return args.join(" \\\n  ");
}

export function shellWords(source: string): string[] {
  const words: string[] = [];
  let word = "";
  let quoteChar = "";
  let started = false;
  const text = source.replace(/\\\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === "\\" && quoteChar !== "'") {
      word += text[++i] ?? "";
      started = true;
    } else if (quoteChar) {
      if (character === quoteChar) quoteChar = "";
      else word += character;
    } else if (character === "'" || character === '"') {
      quoteChar = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quoteChar) throw new Error("The cURL command contains an unclosed quote.");
  if (started) words.push(word);
  return words;
}

const curlAliases: Record<string, string> = {
  "-X": "--request",
  "-H": "--header",
  "-d": "--data",
  "-u": "--user",
  "-L": "--location",
  "-I": "--head",
  "-s": "--silent",
  "-F": "--form",
};
function splitPair(value: string) {
  const at = value.indexOf("=");
  return newPair(at < 0 ? value : value.slice(0, at), at < 0 ? "" : value.slice(at + 1));
}
function curlBody(request: ApiRequest, word: string, value: string, explicit: boolean) {
  if (!explicit) request.method = "POST";
  if (["--form", "--data-urlencode"].includes(word)) {
    const pair = splitPair(value);
    if (pair.value.startsWith("@"))
      throw new Error("Choose local files in the Body tab after importing.");
    request.body.type = word === "--form" ? "multipart" : "urlencoded";
    request.body.fields.push(pair);
    return;
  }
  if (value.startsWith("@") && word !== "--data-raw")
    throw new Error("Choose local files in the Body tab after importing.");
  request.body.type = "text";
  request.body.text = request.body.text ? `${request.body.text}&${value}` : value;
}
function applyCurlValue(request: ApiRequest, word: string, value: string, explicit: boolean) {
  switch (word) {
    case "--request":
      request.method = requestSchema.shape.method.parse(value.toUpperCase());
      return;
    case "--header": {
      const at = value.indexOf(":");
      if (at < 1) throw new Error("Headers must have a name and value separated by a colon.");
      request.headers.push(newPair(value.slice(0, at), value.slice(at + 1).trim()));
      return;
    }
    case "--url":
      request.url = value;
      return;
    case "--url-query":
      request.params.push(splitPair(value));
      return;
    case "--user": {
      const at = value.indexOf(":");
      request.auth = {
        type: "basic",
        username: at < 0 ? value : value.slice(0, at),
        password: at < 0 ? "" : value.slice(at + 1),
      };
      return;
    }
    default:
      curlBody(request, word, value, explicit);
  }
}
const curlValueFlags = new Set([
  "--request",
  "--header",
  "--url",
  "--url-query",
  "--user",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--form",
]);
function hasJsonHeader(request: ApiRequest) {
  return request.headers.some(
    (header) =>
      header.enabled &&
      header.key.toLowerCase() === "content-type" &&
      header.value.includes("json"),
  );
}
export function fromCurl(source: string): ApiRequest {
  const words = shellWords(source);
  if (words.shift() !== "curl") throw new Error("Paste a cURL command beginning with curl.");
  const request = newRequest();
  request.followRedirects = false;
  let explicit = false;
  while (words.length) {
    const raw = words.shift()!;
    const word = curlAliases[raw] ?? raw;
    if (curlValueFlags.has(word)) {
      const value = words.shift();
      if (value === undefined) throw new Error(`Missing value for ${word}.`);
      applyCurlValue(request, word, value, explicit);
      if (word === "--request") explicit = true;
    } else if (word === "--location") request.followRedirects = true;
    else if (word === "--head") {
      request.method = "HEAD";
      explicit = true;
    } else if (["--compressed", "--silent", "--globoff"].includes(word)) continue;
    else if (word.startsWith("-"))
      throw new Error(`Unsupported cURL option ${word}. Remove it before importing.`);
    else if (!request.url) request.url = word;
    else throw new Error("Import one cURL request at a time.");
  }
  if (!request.url) throw new Error("The cURL command has no URL.");
  if (request.body.type === "text" && hasJsonHeader(request)) request.body.type = "json";
  request.name = request.url;
  return requestSchema.parse(request);
}

const postmanPair = z.object({
  key: z.string(),
  value: z.unknown().optional(),
  disabled: z.boolean().optional(),
});
const postmanRequest = z.object({
  method: z.string(),
  url: z.union([z.string(), z.object({ raw: z.string() })]),
  header: z.array(postmanPair).optional(),
  body: z
    .object({
      mode: z.string(),
      raw: z.string().optional(),
      urlencoded: z.array(postmanPair).optional(),
      formdata: z.array(postmanPair.extend({ type: z.string().optional() })).optional(),
    })
    .optional(),
  auth: z
    .object({
      type: z.string(),
      bearer: z.array(postmanPair).optional(),
      basic: z.array(postmanPair).optional(),
      apikey: z.array(postmanPair).optional(),
    })
    .optional(),
});
type PostmanRequest = z.infer<typeof postmanRequest>;
function postmanPairs(pairs: z.infer<typeof postmanPair>[]) {
  return pairs.map((pair) =>
    Object.assign(newPair(pair.key, String(pair.value ?? "")), { enabled: !pair.disabled }),
  );
}
function applyPostmanBody(request: ApiRequest, source: PostmanRequest) {
  if (source.body?.formdata?.some((pair) => pair.type === "file"))
    throw new Error(
      "This collection contains file uploads. Choose files manually after importing requests without these bodies.",
    );
  if (source.body?.mode === "raw") {
    request.body.type = request.headers.some(
      (header) => header.key.toLowerCase() === "content-type" && header.value.includes("json"),
    )
      ? "json"
      : "text";
    request.body.text = source.body.raw ?? "";
  } else if (source.body?.mode === "urlencoded" || source.body?.mode === "formdata") {
    request.body.type = source.body.mode === "formdata" ? "multipart" : "urlencoded";
    const pairs = source.body.urlencoded ?? source.body.formdata ?? [];
    request.body.fields = postmanPairs(pairs);
  } else if (source.body?.mode && source.body.mode !== "none")
    throw new Error(`Body mode ${source.body.mode} requires manual setup after import.`);
}
function applyPostmanAuth(request: ApiRequest, source: PostmanRequest) {
  const auth = source.auth;
  const entries = auth?.bearer ?? auth?.basic ?? auth?.apikey ?? [];
  const values = new Map(entries.map((entry) => [entry.key, String(entry.value ?? "")]));
  const value = (key: string) => values.get(key) ?? "";
  if (auth?.type === "bearer") request.auth = { type: "bearer", token: value("token") };
  else if (auth?.type === "basic")
    request.auth = {
      type: "basic",
      username: value("username"),
      password: value("password"),
    };
  else if (auth?.type === "apikey")
    request.auth = {
      type: "api-key",
      key: value("key"),
      value: value("value"),
      location: values.get("in") === "query" ? "query" : "header",
    };
  else if (auth?.type && auth.type !== "noauth")
    throw new Error(`Authorization type ${auth.type} requires manual setup.`);
}
function importPostmanRequest(value: unknown, name: string): ApiRequest {
  const source = postmanRequest.parse(value);
  const request = newRequest();
  request.name = name;
  request.method = requestSchema.shape.method.parse(source.method.toUpperCase());
  request.url = typeof source.url === "string" ? source.url : source.url.raw;
  request.headers = postmanPairs(source.header ?? []);
  applyPostmanBody(request, source);
  applyPostmanAuth(request, source);
  return requestSchema.parse(request);
}
export function importCollection(text: string): Collection {
  if (text.trimStart().startsWith("curl "))
    return { id: crypto.randomUUID(), name: "Imported cURL", requests: [fromCurl(text)] };
  const data: unknown = JSON.parse(text);
  const own = collectionSchema.safeParse(data);
  if (own.success) return { ...cloneCollection(own.data), name: own.data.name };
  const source = z
    .object({
      info: z.object({ name: z.string() }),
      item: z.array(z.unknown()),
      auth: z.unknown().optional(),
      variable: z
        .array(
          z.object({
            key: z.string(),
            value: z.unknown().optional(),
            disabled: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .parse(data);
  const requests: ApiRequest[] = [];
  const folders: NonNullable<Collection["folders"]> = [];
  const locations: Record<string, string> = {};
  const walk = (items: unknown[], parent: string, inheritedAuth: unknown) => {
    for (const value of items) {
      const item = z
        .object({
          name: z.string(),
          request: z.unknown().optional(),
          item: z.array(z.unknown()).optional(),
          auth: z.unknown().optional(),
        })
        .parse(value);
      const name = item.name;
      if (item.item) {
        const folder = { id: crypto.randomUUID(), name, parentId: parent || null };
        folders.push(folder);
        walk(item.item, folder.id, item.auth ?? inheritedAuth);
      } else {
        const raw = z.record(z.string(), z.unknown()).parse(item.request);
        const request = importPostmanRequest({ ...raw, auth: raw.auth ?? inheritedAuth }, name);
        requests.push(request);
        if (parent) locations[request.id] = parent;
      }
    }
  };
  walk(source.item, "", source.auth);
  if (!requests.length) throw new Error("The collection contains no HTTP requests.");
  return collectionSchema.parse({
    id: crypto.randomUUID(),
    name: source.info.name,
    variables: source.variable?.map((variable) =>
      Object.assign(
        newPair(
          variable.key,
          typeof variable.value === "string"
            ? variable.value
            : JSON.stringify(variable.value ?? ""),
        ),
        { enabled: !variable.disabled },
      ),
    ),
    requests,
    folders,
    locations,
  });
}
