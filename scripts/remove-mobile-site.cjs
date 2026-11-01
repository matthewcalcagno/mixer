// Remove mobile-only website targets, without changing desktop release selection.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../packages/website/src");
const plans = {
  "downloads.tsx": ["appStoreUrl", "playStoreUrl", "MOBILE_STORES", "AndroidIcon", "PlayStoreIcon"],
  "components/landing-page.tsx": ["PhoneShowcase", "StoreButton", "StoreIconLinks"],
  "components/site-footer.tsx": [],
  "routes/{-$locale}/download.tsx": ["PhoneIcon"],
  "latest-release.ts": [
    "ANDROID_RELEASE_CACHE_KEY",
    "getLatestAndroidVersionFromReleases",
    "fetchLatestAndroidVersion",
    "isAndroidVersion",
    "getLatestAndroidVersion",
  ],
  "latest-release.test.ts": ["release"],
  "server-entry.ts": [],
  "components/mockup/index.ts": [],
};
function includes(node, predicate) {
  return predicate(node) || Boolean(ts.forEachChild(node, (child) => includes(child, predicate)));
}
function name(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : "";
}
function mobileHref(attributes) {
  return attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      property.name.text === "href" &&
      property.initializer &&
      ts.isJsxExpression(property.initializer) &&
      property.initializer.expression &&
      ts.isIdentifier(property.initializer.expression) &&
      ["appStoreUrl", "playStoreUrl"].includes(property.initializer.expression.text),
  );
}
for (const [relative, retired] of Object.entries(plans)) {
  const file = path.join(root, relative);
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = ts.transform(source, [
    (context) => {
      // eslint-disable-next-line complexity -- Each branch removes one retired publication shape.
      const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && retired.includes(name(node))) return undefined;
        if (ts.isVariableStatement(node)) {
          const remaining = node.declarationList.declarations.filter(
            (declaration) => !retired.includes(name(declaration)),
          );
          if (!remaining.length) return undefined;
          node = ts.factory.updateVariableStatement(
            node,
            node.modifiers,
            ts.factory.updateVariableDeclarationList(node.declarationList, remaining),
          );
        }
        if (
          relative === "downloads.tsx" &&
          ts.isPropertyAssignment(node) &&
          name(node) === "androidApk"
        )
          return undefined;
        if (relative === "components/landing-page.tsx" && ts.isArrayLiteralExpression(node)) {
          node = ts.factory.updateArrayLiteralExpression(
            node,
            node.elements.filter(
              (element) =>
                !ts.isObjectLiteralExpression(element) ||
                !element.properties.some(
                  (property) =>
                    ts.isPropertyAssignment(property) &&
                    name(property) === "text" &&
                    ts.isStringLiteral(property.initializer) &&
                    /mobile|phone/i.test(property.initializer.text),
                ),
            ),
          );
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier?.text?.startsWith("./mobile/"))
          return undefined;
        if (
          relative === "server-entry.ts" &&
          ts.isIfStatement(node) &&
          node.expression.getText(source).includes('"/android-version.txt"')
        )
          return undefined;
        if (
          relative === "latest-release.test.ts" &&
          ts.isExpressionStatement(node) &&
          ts.isCallExpression(node.expression) &&
          node.expression.arguments[0]?.text === "getLatestAndroidVersionFromReleases"
        )
          return undefined;
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "PhoneShowcase")
          return undefined;
        if (
          ts.isJsxSelfClosingElement(node) &&
          node.attributes.properties.some(
            (property) =>
              ts.isJsxAttribute(property) &&
              property.name.text === "icon" &&
              property.initializer &&
              ts.isJsxExpression(property.initializer) &&
              property.initializer.expression?.getText(source) === "Smartphone",
          )
        )
          return undefined;
        if (ts.isJsxElement(node)) {
          if (mobileHref(node.openingElement.attributes)) return undefined;
          if (
            node.openingElement.tagName.getText(source) === "section" &&
            includes(node, (child) => ts.isStringLiteral(child) && child.text === "download.mobile")
          )
            return undefined;
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit);
    },
  ]);
  fs.writeFileSync(file, ts.createPrinter().printFile(result.transformed[0]));
  result.dispose();
  console.log(relative);
}
const replacements = [
  ["Mobile and Desktop App", "Desktop App"],
  ["mobile and desktop app", "desktop app"],
  ["phone or desktop", "desktop"],
  ["phone and desktop", "desktop"],
  ["from your phone", "from the desktop"],
  ["on your phone", "on the desktop"],
  ["mobile, desktop, web, and CLI", "desktop and CLI"],
  ["移动端与桌面端", "桌面端"],
  ["手机或桌面端", "桌面端"],
  ["从手机", "从桌面端"],
  ["在手机上", "在桌面端"],
];
function rewriteCopy(value) {
  if (typeof value === "string")
    return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  if (Array.isArray(value)) return value.map(rewriteCopy);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteCopy(child)]),
    );
  return value;
}
for (const locale of ["en", "zh-CN"]) {
  const file = path.join(root, "i18n/resources", `${locale}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(rewriteCopy(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2) + "\n",
  );
}
