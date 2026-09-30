/**
 * Build-time text rewriting, applied only to an explicit per-file whitelist wired in build.js —
 * not a general-purpose i18n mechanism. Every mode hard-fails the build when upstream drifts, so
 * changed wording breaks the build instead of silently leaving stale "Segment" text in place.
 *
 * options.replacements: [[search, replace], ...] literal substitutions; a missing `search` throws.
 * options.replaceFileWith + options.expectedSha256: swap the whole file for a hand-written one,
 *   for text a word swap would turn into nonsense. Throws if the upstream file's hash changed.
 */
const crypto = require("crypto");
const fs = require("fs");

module.exports = function stringReplaceLoader(source) {
    const options = this.getOptions();

    if (options.replaceFileWith) {
        const actual = crypto.createHash("sha256").update(source).digest("hex");

        if (actual !== options.expectedSha256) {
            throw new Error(
                `karcher-ui: upstream ${this.resourcePath} changed. Review it against ${options.replaceFileWith}, ` +
                `then set expectedSha256 to ${actual}`
            );
        }

        this.addDependency(options.replaceFileWith);

        return fs.readFileSync(options.replaceFileWith, "utf8");
    }

    const replacements = options.replacements || [];

    let result = source;

    for (const [search, replace] of replacements) {
        if (!result.includes(search)) {
            throw new Error(
                `karcher-ui string replacement: expected string not found in ${this.resourcePath}:\n  ${JSON.stringify(search)}`
            );
        }

        result = result.split(search).join(replace);
    }

    return result;
};
