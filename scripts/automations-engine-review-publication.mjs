// Keep review publication inside the existing exact-PR command guard.
export function adaptGitHubReviewPublication(file, text) {
  const replace = (before, after) => {
    if (!text.includes(before))
      throw new Error(`Review the upstream review-publication seam in ${file}: ${before}`);
    text = text.replace(before, after);
  };
  if (file === "packages/extension-github/src/publication.ts") {
    replace(
      "  allowedReviewCommentIds?: number[];",
      "  allowedReviewCommentIds?: number[];\n  pendingReviewId?: number;",
    );
    replace("const guardGh = () => {", `${reviewGuard}\nconst guardGh = () => {`);
    replace(
      "      const match = /^repos",
      `      const review = guardReviewApi(capability, method, endpoint);
      if (review) return review;
      const match = /^repos`,
    );
    replace(
      '    if (result.status === 0 && guarded.post === "pr-create") {',
      `    if (guarded.bodyFile && guarded.post !== "issue-comment") fs.rmSync(guarded.bodyFile, { force: true });
    if (result.status === 0 && guarded.post === "review-create") {
      const pending = reviewApiReviews("repos/" + guarded.capability.repository + "/pulls/" + guarded.capability.prNumber)
        .filter(review => review.state === "PENDING" && review.user?.login?.toLowerCase() === guarded.capability.authenticatedLogin.toLowerCase());
      if (pending.length !== 1 || !Number.isSafeInteger(pending[0].id)) throw new Error("Mixer Automations could not confirm the pending review; inspect GitHub before retrying");
      guarded.capability.pendingReviewId = pending[0].id;
      writeCapability(guarded.capability);
    }
    if (result.status === 0 && guarded.post === "review-submit") {
      delete guarded.capability.pendingReviewId;
      writeCapability(guarded.capability);
    }
    if (result.status === 0 && guarded.post === "pr-create") {`,
    );
  }
  if (file === "packages/extension-github/src/index.ts") {
    replace(
      "} : prNumber ? { prNumber, prAuthor: data.pullRequestAuthor }",
      "} : prNumber ? { prNumber, prAuthor: data.pullRequestAuthor, activatedRemoteSha: data.headSha }",
    );
    replace(
      "Do not commit, push, edit, close, create another PR, or run a direct merge; review and comment on that exact PR only.",
      "Do not commit, push, edit, close, create another PR, or run a direct merge; review and comment on that exact PR only. Guarded gh api POST to repos/<owner>/<repo>/pulls/<number>/reviews supports pending reviews with commit_id bound to the activated head and all inline findings supplied together in the comments array. Submit that run-owned pending review through POST reviews/<review-id>/events. This supported procedure replaces older guard versions that rejected review creation. Historical rejections in memory do not establish that the current supported procedure is blocked; refresh live state and follow current capabilities. Never retry a fresh rejection through another path. Other mutating API routes remain restricted.",
    );
  }
  if (file === "docs/github.md") {
    replace(
      "## Deferred triggers",
      `### Guarded review publication

Review-only runs may create a pending review through \u0060gh api --method POST repos/<owner>/<repo>/pulls/<number>/reviews --input review.json\u0060. Include the activated head as \u0060commit_id\u0060 and supply all inline findings together in the \u0060comments\u0060 array. Omit \u0060event\u0060 to keep the review pending. Submit it with \u0060POST repos/<owner>/<repo>/pulls/<number>/reviews/<review-id>/events\u0060 and an explicit \u0060event\u0060. The guard checks the live head, open/non-draft state, prior reviews, and run ownership before submission. It never adopts another pending review. Use one JSON input file or explicit scalar fields, not mixed inputs, stdin, transport overrides, or arbitrary GraphQL mutations. After an ambiguous response, inspect live state before retrying.

Snapshot workflows using \u0060oncePerHead\u0060 delay retries of a blocked outcome for 30 minutes, bounded by history retention. This does not mark the work successful. A changed workflow definition, changed head/base revision, or explicit replay bypasses the delay. New comment and review events remain independent.

## Deferred triggers`,
    );
  }
  if (file === "packages/extension-github/src/review-replies.test.ts") {
    replace("  mergeAction?: boolean;", "  mergeAction?: boolean;\n  reviewPublication?: boolean;");
    replace(
      '  const captured = path.join(home, "requests.jsonl");',
      `  const captured = path.join(home, "requests.jsonl");
  const reviewState = path.join(home, "reviews.json");
  fs.writeFileSync(reviewState, JSON.stringify({ head: sha, reviews: [] }));`,
    );
    replace(
      "const args = process.argv.slice(2);",
      `const args = process.argv.slice(2);
if (\u0024{JSON.stringify(options.reviewPublication ?? false)}) {
  const file = \u0024{JSON.stringify(reviewState)};
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const endpoint = args.find(arg => arg.startsWith('repos/'));
  const post = args.includes('POST');
  if (post) {
    const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
    fs.appendFileSync(\u0024{JSON.stringify(captured)}, JSON.stringify(args) + '\\\\n');
    if (endpoint.endsWith('/events')) state.reviews[0].state = 'COMMENTED';
    else state.reviews.push({ id: 101, commit_id: body.commit_id, state: body.event ? 'COMMENTED' : 'PENDING', user: { login: 'maintainer' }, body: body.body ?? '', comments: body.comments ?? [] });
    fs.writeFileSync(file, JSON.stringify(state));
    console.log(JSON.stringify(state.reviews[0]));
  } else if (endpoint.includes('/reviews?')) console.log(JSON.stringify(state.reviews));
  else if (endpoint.endsWith('/reviews/101')) console.log(JSON.stringify(state.reviews[0]));
  else console.log(JSON.stringify({ state: 'open', draft: false, merged: false, head: { sha: state.head } }));
  process.exit(0);
}`,
    );
    replace(
      "return { activate, invoke, requests };",
      "return { activate, invoke, requests, reviewState };",
    );
    replace(
      'describe("activated review replies", () => {',
      `${publicationTests}\ndescribe("activated review replies", () => {`,
    );
  }
  return text;
}

const publicationTests = `describe("guarded pending review publication", () => {
  it("creates a SHA-bound review with inline findings and submits only its own pending review", async () => {
    const check = await fixture({ thirdParty: true, reviewPublication: true });
    await check.activate();
    const bodyFile = path.join(path.dirname(check.reviewState), "body.json");
    fs.writeFileSync(bodyFile, JSON.stringify({ commit_id: sha, comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "A verified finding" }] }));
    const root = "repos/owner/repo/pulls/42/reviews";
    const created = check.invoke(["api", "--method", "POST", root, "--input", bodyFile, "--jq", ".id"]);
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(check.reviewState, "utf8")).reviews).toEqual([
      { id: 101, commit_id: sha, state: "PENDING", user: { login: "maintainer" }, body: "", comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "A verified finding" }] },
    ]);
    expect(check.invoke(["api", "--method", "POST", root + "/102/events", "-f", "event=COMMENT"]).status).toBe(73);
    const submitted = check.invoke(["api", "--method", "POST", root + "/101/events", "-f", "event=COMMENT"]);
    expect(submitted.status, submitted.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(check.reviewState, "utf8")).reviews[0].state).toBe("COMMENTED");
    expect(check.requests()).toHaveLength(2);
    expect(check.invoke(["api", "--method", "POST", root, "-f", "commit_id=" + sha, "-f", "event=COMMENT"]).status).toBe(73);
    expect(check.requests()).toHaveLength(2);
  });

  it.each(["changed head", "changed review owner"])("revalidates %s immediately before submission", async scenario => {
    const check = await fixture({ thirdParty: true, reviewPublication: true });
    await check.activate();
    const root = "repos/owner/repo/pulls/42/reviews";
    const created = check.invoke(["api", "--method", "POST", root, "-f", "commit_id=" + sha]);
    expect(created.status, created.stderr).toBe(0);
    const state = JSON.parse(fs.readFileSync(check.reviewState, "utf8"));
    if (scenario === "changed head") state.head = "b".repeat(40);
    else state.reviews[0].user.login = "another-reviewer";
    fs.writeFileSync(check.reviewState, JSON.stringify(state));
    expect(check.invoke(["api", "--method", "POST", root + "/101/events", "-f", "event=COMMENT"]).status).toBe(73);
    expect(check.requests()).toHaveLength(1);
  });

  it.each(["wrong PR", "wrong head", "changed live head", "unrelated pending", "transport override", "mixed input"])("rejects %s without forwarding a review mutation", async scenario => {
    const check = await fixture({ thirdParty: true, reviewPublication: true });
    await check.activate();
    const args = ["api", "--method", "POST", "repos/owner/repo/pulls/42/reviews", "-f", "commit_id=" + sha];
    if (scenario === "wrong PR") args[3] = "repos/owner/repo/pulls/43/reviews";
    if (scenario === "wrong head") args[5] = "commit_id=" + "b".repeat(40);
    if (scenario === "changed live head") fs.writeFileSync(check.reviewState, JSON.stringify({ head: "b".repeat(40), reviews: [] }));
    if (scenario === "unrelated pending") fs.writeFileSync(check.reviewState, JSON.stringify({ head: sha, reviews: [{ id: 99, state: "PENDING", user: { login: "maintainer" } }] }));
    if (scenario === "transport override") args.push("--hostname", "other.example.com");
    if (scenario === "mixed input") args.push("--input", check.reviewState);
    expect(check.invoke(args).status).toBe(73);
    expect(check.requests()).toEqual([]);
  });
});`;

const reviewGuard = String.raw`const reviewApiRead = endpoint => {
  const result = run("gh", ["api", "--method", "GET", endpoint], { capture: true });
  if (result.status !== 0) throw new Error("Mixer Automations could not verify live review publication state");
  return JSON.parse(result.stdout);
};
const reviewApiReviews = root => {
  const reviews = [];
  for (let page = 1; page <= 100; page++) {
    const batch = reviewApiRead(root + "/reviews?per_page=100&page=" + page);
    if (!Array.isArray(batch)) throw new Error("Mixer Automations could not parse review history");
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
  throw new Error("Mixer Automations review history exceeded 100 pages");
};
const guardReviewApi = (capability, method, endpoint) => {
  const match = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews(?:\/(\d+)\/events)?$/.exec(endpoint || "");
  if (!match) return undefined;
  if (method !== "POST" || match[1] !== capability.repository || Number(match[2]) !== capability.prNumber) {
    throw new Error("Mixer Automations review publication requires POST to the exact activated pull request");
  }
  // Reject transport overrides and ambiguous inputs rather than validate one body
  // and let gh send another. Rewrite the accepted payload to a private JSON file.
  const payload = {};
  const retained = ["api", "--method", "POST", endpoint];
  let input;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    const flag = arg.split("=", 1)[0];
    if (arg === endpoint) continue;
    if (["--method", "-X"].includes(flag)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      if (value?.toUpperCase() !== "POST") throw new Error("Mixer Automations review publication requires POST");
      continue;
    }
    if (["--input", "--field", "--raw-field", "-f", "-F"].includes(flag)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      if (flag === "--input") {
        if (input !== undefined || value === "-") throw new Error("Mixer Automations review publication requires one explicit JSON file, not stdin");
        input = JSON.parse(fs.readFileSync(value, "utf8"));
      } else {
        const separator = value?.indexOf("=") ?? -1;
        if (separator <= 0) throw new Error("Mixer Automations review publication requires explicit field values");
        const key = value.slice(0, separator);
        if (Object.hasOwn(payload, key) || key.includes("[") || value.slice(separator + 1).startsWith("@")) throw new Error("Mixer Automations review publication requires JSON input for complex fields");
        payload[key] = value.slice(separator + 1);
      }
    } else if (["--jq", "-q", "--template", "-t"].includes(flag)) {
      retained.push(arg);
      if (!arg.includes("=")) retained.push(args[++index]);
    } else if (["--silent", "--include", "-i", "--verbose"].includes(arg)) retained.push(arg);
    else throw new Error("Mixer Automations review publication rejects unsupported option or transport override " + flag);
  }
  if (input !== undefined && Object.keys(payload).length) throw new Error("Mixer Automations review publication rejects mixed body inputs");
  const body = input ?? payload;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Mixer Automations review publication requires a JSON object");
  const login = capability.authenticatedLogin;
  const head = capability.expectedRemoteSha || capability.activatedRemoteSha;
  if (!login || !/^[0-9a-f]{40}$/.test(head ?? "")) throw new Error("Mixer Automations review publication requires an attested account and head");
  const root = "repos/" + capability.repository + "/pulls/" + capability.prNumber;
  const live = reviewApiRead(root);
  if (live.state !== "open" || live.merged || live.draft || live.head?.sha !== head) throw new Error("Mixer Automations review publication rejected changed head or ineligible pull request");
  const id = match[3] && Number(match[3]);
  if (id) {
    if (id !== capability.pendingReviewId) throw new Error("Mixer Automations review submission requires this run's pending review");
    const review = reviewApiRead(root + "/reviews/" + id);
    if (review.state !== "PENDING" || review.commit_id !== head || review.user?.login?.toLowerCase() !== login.toLowerCase()) throw new Error("Mixer Automations pending review ownership or head changed");
    if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(body.event) || Object.keys(body).some(key => !['event', 'body'].includes(key))) throw new Error("Mixer Automations review submission requires a supported event and body");
  } else {
    if (body.commit_id !== head || (body.event !== undefined && !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(body.event)) ||
        Object.keys(body).some(key => !['commit_id', 'event', 'body', 'comments'].includes(key))) throw new Error("Mixer Automations review creation requires the exact activated commit_id and supported review fields");
    // Fail closed on truncated history. Do not reuse another run's pending review.
    const reviews = reviewApiReviews(root);
    if (reviews.some(review => review.user?.login?.toLowerCase() === login.toLowerCase() &&
        (review.state === "PENDING" || (review.commit_id === head && review.state !== "DISMISSED")))) throw new Error("Mixer Automations review already exists; inspect GitHub before retrying");
  }
  const bodyFile = path.join(path.dirname(configPath), "review-" + randomUUID() + ".json");
  fs.writeFileSync(bodyFile, JSON.stringify(body), { mode: 0o600 });
  args.splice(0, args.length, ...retained, "--input", bodyFile);
  return { capability, post: id ? "review-submit" : body.event === undefined ? "review-create" : undefined, bodyFile };
};`;
