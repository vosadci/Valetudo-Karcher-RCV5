const entities = require("../../entities");

const stateAttrs = entities.state.attributes;

/**
 * `work_mode` → HA state mapping, ported verbatim from `coordinator.py`'s decision
 * tree, documented in karcher-rcv5-ha's doc/PROTOCOL.md §6 ("work_mode → HA State
 * Mapping"). All value sets are APK/device-verified there, not guessed here.
 */
const WORK_MODE_SETS = Object.freeze({
    CLEANING: [1, 7, 25, 30, 36, 81],
    PAUSE: [4, 9, 27, 31, 37, 82],
    GO_HOME: [5, 10, 11, 12, 21, 26, 32, 38, 47],
    IDLE: [0, 14, 23, 29, 35, 40, 85]
});

/**
 * doc/PROTOCOL.md §5 "Area (zone) cleaning": the zone-clean lifecycle family within
 * work_mode — {30 cleaning, 31 paused, 32 returning}, a subset of the generic
 * CLEANING/PAUSE/GO_HOME sets above. Pause/resume/stop must route through
 * `set_zone_clean` rather than `set_room_clean` while work_mode is one of these — the
 * app decides this the same way (`IotBase.getCleanMode == 6`). Deliberately excludes
 * 35 (idle): unlike the HA integration (which also treats idle as zone-eligible to
 * recover a "resume" intent across its own restarts), this capability has no
 * cross-restart session state to recover, so idle here just means "nothing active,
 * route normally."
 */
const ZONE_WORK_MODES = Object.freeze([30, 31, 32]);

/**
 * doc/PROTOCOL.md §5 "Set suction power (fan speed)": wind 0-3, confirmed via traffic
 * capture. Mapped onto Valetudo's INTENSITY ladder the same way Viomi's 4-level fan
 * speed does (LOW/MEDIUM/HIGH/MAX) — see ViomiCommonAttributes.js.
 */
const WIND_TO_PRESET = Object.freeze({
    0: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW, // "Silent"
    1: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM, // "Standard"
    2: stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH, // "Medium"
    3: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX // "Turbo"
});
const PRESET_TO_WIND = Object.freeze(
    Object.fromEntries(Object.entries(WIND_TO_PRESET).map(([k, v]) => [v, parseInt(k, 10)]))
);

/**
 * doc/PROTOCOL.md §5 "Set water level (mop)": water 0-2, 0-based (device-confirmed).
 * Matches Viomi's 3-level water grade convention exactly (LOW/MEDIUM/HIGH).
 */
const WATER_TO_PRESET = Object.freeze({
    0: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW,
    1: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM,
    2: stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH
});
const PRESET_TO_WATER = Object.freeze(
    Object.fromEntries(Object.entries(WATER_TO_PRESET).map(([k, v]) => [v, parseInt(k, 10)]))
);

/**
 * doc/PROTOCOL.md §5 "Set cleaning mode (vacuum / mop / both)": mode 0-2,
 * device-confirmed. No VACUUM_THEN_MOP equivalent exists on this device.
 */
const MODE_TO_PRESET = Object.freeze({
    0: stateAttrs.PresetSelectionStateAttribute.MODE.VACUUM,
    1: stateAttrs.PresetSelectionStateAttribute.MODE.VACUUM_AND_MOP,
    2: stateAttrs.PresetSelectionStateAttribute.MODE.MOP
});
const PRESET_TO_MODE = Object.freeze(
    Object.fromEntries(Object.entries(MODE_TO_PRESET).map(([k, v]) => [v, parseInt(k, 10)]))
);

/**
 * doc/PROTOCOL.md §6 consumable full-life values, converted from hours to minutes to
 * match the unit the device reports usage in (`main_brush`/`side_brush`/`hypa`/
 * `mop_life` are all "use time in minutes").
 */
const CONSUMABLE_FULL_LIFE_MINUTES = Object.freeze({
    main_brush: 360 * 60,
    side_brush: 180 * 60,
    hypa: 180 * 60,
    mop_life: 180 * 60
});

/**
 * doc/PROTOCOL.md §5 "Reset consumable timer": service.reset_consumable {consumable: N}.
 */
const CONSUMABLE_RESET_IDS = Object.freeze({
    main_brush: 1,
    side_brush: 2,
    hypa: 3,
    mop_life: 4
});

/**
 * Map-overlay constants, ported from the karcher-rcv5-ha HA integration's
 * map_parser.py/map_render.py, which already draws these correctly against a real
 * account/device — see that repo's doc/MAP_DATA.md §6.4/§6.7 for the underlying
 * research.
 */

// RobotMap.furniture_info type_id marking an area carpet (rug), as opposed to an
// actual piece of furniture. APK-verified: GlobalRender.updateMatericalSpecialInfo.
const FURNITURE_CARPET_TYPE_ID = 1550;

// RobotMap.objects type_id that duplicates the area-carpet polygon above — the app
// also reports carpets as an AI object detection, which would otherwise render as
// a second, redundant marker on top of the polygon from furniture_info.
const OBJECT_TYPE_CARPET = 1005;

/**
 * RobotMap.virtual_walls (DeviceAreaDataInfo.type) restriction kinds — same codes
 * on both the read/echo side and the send side (set_virtual_wall), device-confirmed
 * both directions. Only virtual_walls (field 9) carries restrictions;
 * RobotMap.areas_info (field 10) is a different concept (the currently-drawn
 * zone-clean rectangle) and must not be treated as one — doing so once made a drawn
 * clean area render as a phantom no-go zone in the HA integration. Unknown/unmapped
 * type codes fall through to ZONE_TYPE_NOGO, so areas still surface even for a type
 * this table doesn't know about yet.
 */
const ZONE_TYPE_NOGO = 1;
const ZONE_TYPE_WALL = 2;
const ZONE_TYPE_NOMOP = 6;

/**
 * doc/PROTOCOL.md "Room management": robot-side language code for the `lang` field
 * in split_room/arrange_room, from the app's own LanguageHelper.java enum
 * (LANGUAGE_TYPE_ENGLISH = 2; LANGUAGE_TYPE_CHINESE = 1; no defined 0 value at all).
 * Used as the fallback when ephemeralState.language hasn't been learned yet.
 * Live-confirmed 2026-09-22: sending 0 (an undefined value in that enum) produced a
 * Chinese default room name ("房间3", "Room 3") after a merge — English (2) is the
 * correct fallback, not 0.
 */
const LANGUAGE_TYPE_ENGLISH = 2;

/**
 * RobotMap.objects (ObjectDataInfo.objectTypeId) → display label, from the app's
 * own AI-recognition categories (mdi icon choices ported from the HA integration's
 * Lovelace card, www/card/map-draw.js OBJECT_ICONS). OBJECT_TYPE_CARPET (1005) is
 * deliberately absent — filtered out before reaching this lookup.
 */
const AI_OBJECT_TYPE_LABELS = Object.freeze({
    1001: "Sock",
    1002: "Shoe",
    1003: "Wire",
    1006: "Cat",
    1007: "Dog",
    1011: "Pet waste",
    1017: "Scale",
    1038: "Chair"
});

/**
 * doc/PROTOCOL.md §6 fault code table (APK-verified). Only the message text is used
 * here — severity/subsystem classification per-code is deliberately not attempted
 * (would be guesswork beyond what's documented); ValetudoRobotError falls back to
 * UNKNOWN/UNKNOWN for all of them.
 */
const FAULT_MESSAGES = Object.freeze({
    100: "Hardware driver error",
    500: "LiDAR timeout",
    501: "Wheel lifted",
    502: "Battery too low to start",
    503: "Dust box not installed",
    504: "Geomagnetic sensor fault",
    505: "Failed to start from dock",
    506: "Follow IR sensor exception",
    507: "Relocalization failed",
    508: "Cannot start on slope",
    509: "Cliff IR sensor fault",
    510: "Bumper sensor fault",
    511: "Failed to return to dock",
    512: "Place robot on dock",
    513: "Navigation failed",
    514: "Escape from stuck failed",
    515: "Dock clip exception",
    516: "Battery temperature fault",
    517: "System upgrading",
    518: "Waiting for charge to finish",
    519: "Main brush stalled",
    520: "Side brush stalled",
    521: "Water box not installed",
    522: "Mop not installed",
    523: "Dust box full",
    524: "Power switch not on",
    525: "Water tank empty",
    526: "Mop cloth dirty",
    527: "Dust box full",
    530: "Battery temperature abnormal",
    531: "Battery temperature returned to normal",
    2000: "Dust box full",
    2001: "Left brush blocked",
    2002: "Right brush blocked",
    2003: "No power / plan disabled",
    2007: "Cleaning interrupted",
    2010: "ToF sensor abnormal",
    4002: "Map error"
});

/**
 * Lifecycle status codes the real app excludes from its error dialog (shown in a
 * status text widget instead, e.g. "Self-checking", "Relocalizing"). Source:
 * `ControlMainActivity.java`'s `isStatusNoThisFault()`, APK v1.4.32 — the exact
 * set karcher-rcv5-ha's `NON_ERROR_FAULT_CODES` (const.py) ships and verified
 * exhaustively there; ported verbatim rather than re-derived from doc/PROTOCOL.md's
 * fault table, whose `*(status)*` row annotations turned out to be an incomplete
 * subset of this (missing 2100/2101/2106/2111/2112/2118). A fault code in this set
 * must never surface as the Error status, regardless of work_mode/docked state —
 * correspondingly, none of them need a FAULT_MESSAGES entry, since buildRobotError()
 * is never reached for them.
 */
const STATUS_ONLY_FAULT_CODES = Object.freeze(new Set([
    2100, // FAULT_BROKEN_GO_HOME — return-to-dock interrupted
    2101, // FAULT_BROKEN_CHARING — charging interrupted
    2102, // FAULT_ROBOT_GLOBAL_GO_HOME — global return-to-dock in progress
    2103, // FAULT_ROBOT_CHANGING — robot state changing
    2104, // FAULT_ROBOT_USER_GO_HOME — user-initiated return to dock
    2105, // FAULT_ROBOT_CHARGE_FINISH — charging complete
    2106, // FAULT_BROKEN_CHARGING_WAIT — charging-wait interrupted
    2107, // FAULT_GLOBAL_APPOINT_CLEAN — scheduled clean in progress
    2108, // FAULT_ROBOT_RELOCALITION_ING — relocalizing
    2109, // FAULT_ROBOT_REPEAT_CLEAN_ING — repeat cleaning in progress
    2110, // FAULT_ROBOT_SELF_CHECK_ING — self-checking (startup self-test)
    2111, // no named constant in RobotError.java
    2112, // no named constant in RobotError.java
    2118  // no named constant in RobotError.java
]));

/**
 * Human-readable text for the subset of STATUS_ONLY_FAULT_CODES that have a named
 * constant in RobotError.java. Ported verbatim from karcher-rcv5-ha's own shipped
 * `strings.json`/`translations/en.json` (already-verified, user-facing English text),
 * not re-translated here. Deliberately has no entries for 2111/2112/2118 — those have
 * no named constant, so any text here would be a guess; they stay plain "idle" with
 * no message, same as before this feature existed.
 */
const STATUS_MESSAGES = Object.freeze({
    2100: "Return to dock interrupted",
    2101: "Charging interrupted",
    2102: "Returning to dock",
    2103: "Changing state",
    2104: "Returning to dock (user)",
    2105: "Charging complete",
    2106: "Charging wait interrupted",
    2107: "Scheduled clean in progress",
    2108: "Relocalizing",
    2109: "Repeat cleaning in progress",
    2110: "Self-checking"
});

/**
 * The exact property list the real app requests via `prop.get` — ported verbatim
 * from the installed `karcher-home` package's `consts.py` (`ROBOT_PROPERTIES`), not
 * guessed. Confirmed live 2026-09-18 that our dummycloud never sent this request at
 * all, relying entirely on whatever the robot proactively pushes — which left
 * fields like `water` (present in this list) unpopulated until now, causing
 * Valetudo's WaterUsageControlCapability WebUI widget to show "Error loading"
 * (no PresetSelectionStateAttribute had ever been set because no push ever
 * happened to include `water`).
 *
 * Also appends the 4 documented consumable fields (`main_brush`/`side_brush`/
 * `hypa`/`mop_life`, doc/PROTOCOL.md §6) even though the real app's own
 * ROBOT_PROPERTIES list does NOT include them — they're known-real property names
 * (the robot already pushes them unprompted elsewhere) but their absence from the
 * app's own request list means this is an untested extension, not a confirmed
 * behavior. Worth trying since the cost of the robot ignoring unrecognized keys is
 * zero; not yet live-verified whether the robot actually answers with them.
 */
const ROBOT_PROPERTIES = Object.freeze([
    "status", "firmware_code", "firmware", "fault", "mode", "wind", "water",
    "repeat_state", "charge_state", "quantity", "work_mode", "sweep_type",
    "build_map", "cleaning_area", "cleaning_time", "current_map_id", "custom_type",
    "privacy", "alarm", "volume", "tank_state", "cloth_state", "mop_route",
    "map_num", "language", "voice_type", "quiet_status", "quiet_is_open",
    // Not part of the real app's own request list — see comment above.
    "main_brush", "side_brush", "hypa", "mop_life",
    // Suction Station RCV 5 fields (project_auto_empty_dock memory, device-confirmed
    // 2026-08-04) — also not part of the app's own list, same untested-extension
    // reasoning as the consumable fields above.
    "dust_action", "charge_station_type",
    // DND PoC (temporal-honking-treasure.md, "Add Do Not Disturb" section) — also not part
    // of the app's own request list. Untested whether the robot actually answers a prop.get
    // with these; quiet_is_open/quiet_status above already are requested and may carry the
    // same information via quiet_status.begin_time/end_time instead.
    "quiet_begin_time", "quiet_end_time", "time_zone"
]);

module.exports = {
    WORK_MODE_SETS: WORK_MODE_SETS,
    ZONE_WORK_MODES: ZONE_WORK_MODES,
    WIND_TO_PRESET: WIND_TO_PRESET,
    PRESET_TO_WIND: PRESET_TO_WIND,
    WATER_TO_PRESET: WATER_TO_PRESET,
    PRESET_TO_WATER: PRESET_TO_WATER,
    MODE_TO_PRESET: MODE_TO_PRESET,
    PRESET_TO_MODE: PRESET_TO_MODE,
    CONSUMABLE_FULL_LIFE_MINUTES: CONSUMABLE_FULL_LIFE_MINUTES,
    CONSUMABLE_RESET_IDS: CONSUMABLE_RESET_IDS,
    FURNITURE_CARPET_TYPE_ID: FURNITURE_CARPET_TYPE_ID,
    OBJECT_TYPE_CARPET: OBJECT_TYPE_CARPET,
    ZONE_TYPE_NOGO: ZONE_TYPE_NOGO,
    ZONE_TYPE_WALL: ZONE_TYPE_WALL,
    ZONE_TYPE_NOMOP: ZONE_TYPE_NOMOP,
    LANGUAGE_TYPE_ENGLISH: LANGUAGE_TYPE_ENGLISH,
    AI_OBJECT_TYPE_LABELS: AI_OBJECT_TYPE_LABELS,
    FAULT_MESSAGES: FAULT_MESSAGES,
    STATUS_ONLY_FAULT_CODES: STATUS_ONLY_FAULT_CODES,
    STATUS_MESSAGES: STATUS_MESSAGES,
    ROBOT_PROPERTIES: ROBOT_PROPERTIES
};
