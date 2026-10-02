/**
 * PoC Stage 1: reuse Valetudo's own webpack config factory to build a second,
 * independent frontend bundle into frontend/build/karcher-ui/, without touching
 * any file under frontend/ or backend/.
 */
process.env.BABEL_ENV = "production";
process.env.NODE_ENV = "production";
process.env.GENERATE_SOURCEMAP = "false";
process.env.PUBLIC_URL = "/karcher-ui";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const webuiRoot = __dirname;
const frontendDir = path.resolve(webuiRoot, "../../../frontend");

process.chdir(frontendDir);

const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const configFactory = require(path.join(frontendDir, "config/webpack.config"));

const webuiSrc = path.resolve(webuiRoot, "src");
const webuiHtml = path.resolve(webuiRoot, "public/index.html");
const webuiBuild = path.resolve(frontendDir, "build/karcher-ui");

const config = configFactory("production");

config.entry = path.join(webuiSrc, "index.tsx");
config.output.path = webuiBuild;
config.output.publicPath = "/karcher-ui/";
config.cache.cacheDirectory = path.resolve(webuiRoot, ".webpack-cache");

const oneOfRules = config.module.rules.find(rule => rule.oneOf).oneOf;
const babelAppRule = oneOfRules.find(rule => rule.loader && rule.loader.includes("babel-loader") && rule.include);

if (!babelAppRule) {
    throw new Error("Could not find the frontend/src babel-loader rule to extend — webpack.config.js shape changed upstream.");
}

babelAppRule.include = [babelAppRule.include, webuiSrc];

// "Segment" -> "Room" wording, matching the karcher_home_robots
// Lovelace card's terminology (custom_components/karcher_home_robots/www/card/i18n.js,
// karcher-rcv5-ha repo). Applied via enforce:"pre" loaders on raw source, ahead of
// babel-loader, to an explicit per-file whitelist — not a general i18n mechanism. Each
// pair hard-fails the build if the expected source string is missing, so upstream wording
// drift breaks the build instead of silently leaving stale "Segment" text in place.
const stringReplaceLoaderPath = path.resolve(webuiRoot, "stringReplaceLoader.js");

config.module.rules.push(
    {
        enforce: "pre",
        test: /\.tsx$/,
        include: path.join(frontendDir, "src/options/MapManagement.tsx"),
        use: [{
            loader: stringReplaceLoaderPath,
            options: {
                replacements: [
                    ["primaryLabel=\"Segment Management\"", "primaryLabel=\"Room Management\""],
                    ["secondaryLabel=\"Modify the maps segments\"", "secondaryLabel=\"Modify the map's rooms\""],
                ],
            },
        }],
    },
    {
        enforce: "pre",
        test: /\.tsx$/,
        include: path.join(frontendDir, "src/map/actions/edit_map_actions/SegmentActions.tsx"),
        use: [{
            loader: stringReplaceLoaderPath,
            options: {
                replacements: [
                    ["<DialogTitle>Rename Segment</DialogTitle>", "<DialogTitle>Rename Room</DialogTitle>"],
                    ["How should the segment &apos;{currentName}&apos; be called?", "How should the room &apos;{currentName}&apos; be called?"],
                    ["label=\"Segment name\"", "label=\"Room name\""],
                    ["<DialogTitle>Segment Material</DialogTitle>", "<DialogTitle>Room Material</DialogTitle>"],
                    ["What material is the floor of segment &apos;{name}&apos; made of?", "What material is the floor of room &apos;{name}&apos; made of?"],
                    ["Editing segments requires the robot to be docked", "Editing rooms requires the robot to be docked"],
                    ["Please select a segment to start editing", "Please select a room to start editing"],
                ],
            },
        }],
    },
    {
        enforce: "pre",
        test: /\.tsx$/,
        include: path.join(frontendDir, "src/valetudo/timers/ActionControls.tsx"),
        use: [{
            loader: stringReplaceLoaderPath,
            options: {
                replacements: [
                    ["\"Unnamed segment: \"", "\"Unnamed room: \""],
                    ["Available segments", "Available rooms"],
                    ["Selected segments", "Selected rooms"],
                ],
            },
        }],
    },
    {
        enforce: "pre",
        test: /\.tsx$/,
        include: path.join(frontendDir, "src/valetudo/timers/TimerCard.tsx"),
        use: [{
            loader: stringReplaceLoaderPath,
            options: {
                replacements: [
                    ["\"Segment cleanup\"", "\"Room cleanup\""],
                ],
            },
        }],
    },
    // These two help texts explain "segments" as distinct from "rooms", so a word swap would make
    // them self-contradictory. Replaced wholesale; any upstream edit fails the build for re-review.
    {
        enforce: "pre",
        test: /\.ts$/,
        include: path.join(frontendDir, "src/map/res/SegmentEditHelp.ts"),
        use: [{
            loader: stringReplaceLoaderPath,
            options: {
                replaceFileWith: path.resolve(webuiSrc, "help/SegmentEditHelp.room.ts"),
                expectedSha256: "2f777dcc5e992204de9b709179c84162a490ec0480a68115097ff70f55aff23c",
            },
        }],
    },
    {
        enforce: "pre",
        test: /\.ts$/,
        include: path.join(frontendDir, "src/options/res/MapManagementHelp.ts"),
        use: [{
            loader: stringReplaceLoaderPath,
            options: {
                replaceFileWith: path.resolve(webuiSrc, "help/MapManagementHelp.room.ts"),
                expectedSha256: "0e9265e2594a7c681f09439c95e644b8d1dccc968d9bad11fe82b12e0ced2694",
            },
        }],
    },
);

// build.js and the local loader aren't tracked by the reused config's cache invalidation, and
// plugin/resolution changes made here would otherwise be served stale from the persistent cache.
config.cache.buildDependencies.config = [...(config.cache.buildDependencies.config ?? []), __filename, stringReplaceLoaderPath];
config.cache.version = crypto
    .createHash("md5")
    .update(fs.readFileSync(__filename))
    .update(fs.readFileSync(stringReplaceLoaderPath))
    .digest("hex");

// The five reused pages that render list-menu links import react-router's <Link> through this one
// component. Swapping it lets them navigate via the sheet without a Router (see nav/).
const linkListMenuItemReplacement = path.resolve(webuiSrc, "nav/LinkListMenuItem.tsx");

config.plugins.push(
    new webpack.NormalModuleReplacementPlugin(/components\/list_menu\/LinkListMenuItem$/, (resource) => {
        resource.request = linkListMenuItemReplacement;
    })
);

// The live map's room and zone "Clean" buttons are replaced so the action bar's main button starts
// every clean (map/RoomSelectionActions.tsx, map/ZoneTargetActions.tsx). Only LiveMap imports
// live_map_actions/*; EditMap uses edit_map_actions/SegmentActions, which these patterns don't match.
// The replacements rely on the props LiveMap passes. If upstream changes them, fail here, not at runtime.
const liveMapSource = fs.readFileSync(path.join(frontendDir, "src/map/LiveMap.tsx"), "utf8");
const liveMapContract = [
    "import SegmentActions from \"./actions/live_map_actions/SegmentActions\";",
    "<SegmentActions",
    "segments={this.state.selectedSegmentIds}",
    "onClear={() => {",
    "import ZoneActions from \"./actions/live_map_actions/ZoneActions\";",
    "<ZoneActions",
    "zones={this.state.zones}",
    "convertPixelCoordinatesToCMSpace={(coordinates => {",
    "onAdd={() => {",
    "import {LiveMapModeSwitcher} from \"./LiveMapModeSwitcher\";",
    "supportedModes={this.supportedModes}",
    "currentMode={this.state.mode}",
    "setMode={(newMode) => {",
];
const brokenLiveMapContract = liveMapContract.filter(s => !liveMapSource.includes(s));

if (brokenLiveMapContract.length > 0) {
    throw new Error(
        "karcher-ui: frontend/src/map/LiveMap.tsx no longer passes SegmentActions/ZoneActions what map/RoomSelectionActions.tsx " +
        "and map/ZoneTargetActions.tsx expect. " +
        `Missing: ${JSON.stringify(brokenLiveMapContract)}`
    );
}

config.plugins.push(
    new webpack.NormalModuleReplacementPlugin(/live_map_actions\/SegmentActions$/, (resource) => {
        resource.request = path.resolve(webuiSrc, "map/RoomSelectionActions.tsx");
    }),
    new webpack.NormalModuleReplacementPlugin(/live_map_actions\/ZoneActions$/, (resource) => {
        resource.request = path.resolve(webuiSrc, "map/ZoneTargetActions.tsx");
    }),
    new webpack.NormalModuleReplacementPlugin(/\/LiveMapModeSwitcher$/, (resource) => {
        resource.request = path.resolve(webuiSrc, "map/MapModeToggle.tsx");
    })
);

// LiveMapPage renders map/ResettableLiveMap.tsx, a LiveMap subclass that adds the reset-zoom button.
// Scoped to LiveMapPage as the importer: the subclass itself imports the real LiveMap.
const liveMapPageSource = fs.readFileSync(path.join(frontendDir, "src/map/LiveMapPage.tsx"), "utf8");
const baseMapSource = fs.readFileSync(path.join(frontendDir, "src/map/BaseMap.tsx"), "utf8");
const resetZoomContract = [
    [liveMapPageSource, "import LiveMap from \"./LiveMap\";"],
    [baseMapSource, "componentDidMount(): void {"],
    [baseMapSource, "protected ctxWrapper!: Canvas2DContextTrackingWrapper;"],
    [baseMapSource, "protected currentScaleFactor = 1;"],
    [baseMapSource, "protected draw() : void {"],
];
const brokenResetZoomContract = resetZoomContract.filter(([source, s]) => !source.includes(s)).map(([, s]) => s);

if (brokenResetZoomContract.length > 0) {
    throw new Error(
        "karcher-ui: map/LiveMapPage.tsx or map/BaseMap.tsx changed in a way map/ResettableLiveMap.tsx depends on. " +
        `Missing: ${JSON.stringify(brokenResetZoomContract)}`
    );
}

config.plugins.push(
    new webpack.NormalModuleReplacementPlugin(/^\.\/LiveMap$/, (resource) => {
        if ((resource.contextInfo?.issuer ?? "").endsWith(path.join("src", "map", "LiveMapPage.tsx"))) {
            resource.request = path.resolve(webuiSrc, "map/ResettableLiveMap.tsx");
        }
    })
);

config.plugins = config.plugins.filter(plugin => {
    return plugin.constructor.name !== "ForkTsCheckerWebpackPlugin" && plugin.constructor.name !== "ESLintPlugin";
});

const htmlPluginIndex = config.plugins.findIndex(plugin => plugin.constructor.name === "HtmlWebpackPlugin");

if (htmlPluginIndex === -1) {
    throw new Error("Could not find HtmlWebpackPlugin to retarget its template — webpack.config.js shape changed upstream.");
}

config.plugins[htmlPluginIndex] = new HtmlWebpackPlugin({
    inject: true,
    template: webuiHtml,
    minify: {
        removeComments: true,
        collapseWhitespace: true,
        removeRedundantAttributes: true,
        useShortDoctype: true,
        removeEmptyAttributes: true,
        removeStyleLinkTypeAttributes: true,
        keepClosingSlash: true,
        minifyJS: true,
        minifyCSS: true,
        minifyURLs: true,
    },
});

fs.rmSync(webuiBuild, {recursive: true, force: true});
fs.mkdirSync(webuiBuild, {recursive: true});

const compiler = webpack(config);

compiler.run((err, stats) => {
    if (err) {
        console.error(err.stack || err);
        process.exitCode = 1;

        return;
    }

    const info = stats.toJson({all: false, errors: true, warnings: true});

    if (stats.hasErrors()) {
        console.error(info.errors.map(e => e.message || e).join("\n\n"));
        process.exitCode = 1;

        return;
    }

    if (stats.hasWarnings()) {
        console.warn(info.warnings.map(w => w.message || w).join("\n\n"));
    }

    // Fail loudly if an upstream rename/move stops the LinkListMenuItem swap from applying.
    // Checks the emitted JS rather than stats module names: those are unreliable on cache hits.
    const emittedJs = fs.readdirSync(path.join(webuiBuild, "static/js"))
        .filter(f => f.endsWith(".js"))
        .map(f => fs.readFileSync(path.join(webuiBuild, "static/js", f), "utf8"))
        .join("\n");

    const swapFailures = [];

    if (["react-router", "@remix-run/router", "reactrouter.com"].some(s => emittedJs.includes(s))) {
        swapFailures.push("react-router is still bundled (the LinkListMenuItem swap did not apply)");
    }

    // A string only upstream's live-map SegmentActions has
    if (emittedJs.includes("currently selected segments with the currently configured parameters")) {
        swapFailures.push("upstream live-map SegmentActions is still bundled (the RoomSelectionActions swap did not apply)");
    }

    if (emittedJs.includes("Map Mode Selector")) {
        swapFailures.push("upstream LiveMapModeSwitcher is still bundled (the MapModeToggle swap did not apply)");
    }

    if (emittedJs.includes("currently drawn zones with the currently configured parameters")) {
        swapFailures.push("upstream live-map ZoneActions is still bundled (the ZoneTargetActions swap did not apply)");
    }

    if (!emittedJs.includes("Reset zoom")) {
        swapFailures.push("map/ResettableLiveMap.tsx is not bundled (the LiveMapPage swap did not apply)");
    }

    if (swapFailures.length > 0) {
        console.error(`karcher-ui module swap failed: ${swapFailures.join("; ")}`);
        process.exitCode = 1;

        return;
    }

    console.log(`karcher-ui build OK: ${webuiBuild}`);
    compiler.close(() => {});
});
