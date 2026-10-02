const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherMapParser = require("../../../../lib/robots/karcher/KaercherMapParser");

/**
 * Synthetic 4x3 grid exercising every branch of doc/MAP_DATA.md §4.2's byte table
 * (from the karcher-rcv5-ha repo), cross-checked against a real map fixture fetched
 * via karcher-home this session — see project_rcv5_valetudo_step7_live_confirmed
 * memory. Real byte values observed there (0, 1, 255, 10-14, 192-196) all appear
 * here; the remaining ranges (deep-cleaned, cleaned-room, 128-146/197-252/254
 * "unhandled") are exercised synthetically since the real fixture didn't happen to
 * contain them.
 *
 * Grid (row-major, row 0 = world minY = image bottom per doc/MAP_DATA.md §5):
 *   row 0: 0(skip)        1(floor)         255(wall)        10(segment 10, unvisited)
 *   row 1: 65(segment 15, cleaned: 65-50)  192(segment 14 carpet: 206-192)  253(floor carpet, outside room)  3(wall, 3&3==3)
 *   row 2: 130(skip, 128-146)  200(skip, 197-252)  254(skip)  2(floor, deep-cleaned: 2&3==2)
 */
function buildRobotMap() {
    return {
        mapHead: {
            mapHeadId: 42,
            sizeX: 4,
            sizeY: 3,
            minX: 0,
            minY: 0,
            maxX: 0.2,
            maxY: 0.15,
            resolution: 0.05
        },
        mapData: {
            mapData: Buffer.from([
                0, 1, 255, 10,
                65, 192, 253, 3,
                130, 200, 254, 2
            ])
        },
        currentPose: {x: 0.1, y: 0.05, phi: 0}, // facing east
        chargeStation: {x: 0.2, y: 0.15, phi: Math.PI / 2}, // facing north
        historyPose: {
            poseId: 1,
            points: [{x: 0, y: 0}, {x: 0.05, y: 0}]
        },
        roomDataInfo: [
            {roomId: 10, roomName: "Room A"},
            {roomId: 14, roomName: "Room B"}
            // roomId 15 intentionally absent, to cover the "no matching room" path
        ],
        virtualWalls: [
            // Real RCV5 capture, 2026-09-20: the device sends a wall's points as
            // duplicated pairs, not the plain [A, B] the APK-derived doc implied.
            {type: 2, areaIndex: 1, points: [{x: 0, y: 0}, {x: 0, y: 0}, {x: 0.1, y: 0.1}, {x: 0.1, y: 0.1}]}, // line wall
            {type: 1, areaIndex: 2, points: [{x: 0, y: 0}, {x: 0.1, y: 0.05}]}, // no-go, 2-point diagonal
            {type: 6, areaIndex: 3, points: [{x: 0, y: 0}, {x: 0.05, y: 0}, {x: 0.05, y: 0.05}]}, // no-mop
            {type: 99, areaIndex: 4, points: [{x: 0, y: 0}, {x: 0.05, y: 0}, {x: 0.05, y: 0.05}]} // unknown -> no-go fallback
        ],
        furnitureInfo: [
            {
                id: 7,
                typeId: 1550, // area carpet
                points: [
                    {x: 0.05, y: 0}, {x: 0.1, y: 0}, {x: 0.1, y: 0.05}, {x: 0.05, y: 0.05},
                    {x: 999, y: 999} // 5th point must be ignored, matching the app's own quad-only behaviour
                ]
            },
            {id: 8, typeId: 999, points: [{x: 0, y: 0}, {x: 0.05, y: 0}, {x: 0.05, y: 0.05}]} // real furniture, not a carpet
        ],
        objects: [
            {objectId: 5, objectTypeId: 1002, x: 0.1, y: 0.1}, // shoe
            {objectId: 6, objectTypeId: 9999, x: 0, y: 0}, // unknown type -> generic label
            {objectId: 7, objectTypeId: 1005, x: 0, y: 0} // carpet AI-detection, must be filtered
        ]
    };
}

function findLayer(map, type, segmentId) {
    return map.layers.find(l => {
        return l.type === type && (segmentId === undefined || l.metaData.segmentId === `${segmentId}`);
    });
}

describe("KaercherMapParser", () => {
    describe("DECODE_CELL", () => {
        it("decodes every branch of the byte table", () => {
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(0), {kind: "skip"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(1), {kind: "floor"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(2), {kind: "floor"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(3), {kind: "wall"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(255), {kind: "wall"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(253), {kind: "floor", carpet: true});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(10), {kind: "segment", segmentId: 10});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(59), {kind: "segment", segmentId: 59});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(60), {kind: "segment", segmentId: 10});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(65), {kind: "segment", segmentId: 15});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(127), {kind: "segment", segmentId: 77});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(147), {kind: "segment", segmentId: 59, carpet: true});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(192), {kind: "segment", segmentId: 14, carpet: true});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(196), {kind: "segment", segmentId: 10, carpet: true});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(128), {kind: "skip"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(146), {kind: "skip"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(197), {kind: "skip"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(252), {kind: "skip"});
            assert.deepStrictEqual(KaercherMapParser.DECODE_CELL(254), {kind: "skip"});
        });
    });

    describe("PHI_TO_VALETUDO_ANGLE", () => {
        it("maps world phi (0=east, CCW+) to Valetudo compass degrees (0=north, CW+)", () => {
            assert.strictEqual(KaercherMapParser.PHI_TO_VALETUDO_ANGLE(0), 90); // east
            assert.strictEqual(KaercherMapParser.PHI_TO_VALETUDO_ANGLE(Math.PI / 2), 0); // north
            assert.strictEqual(KaercherMapParser.PHI_TO_VALETUDO_ANGLE(Math.PI), 270); // west
            assert.strictEqual(KaercherMapParser.PHI_TO_VALETUDO_ANGLE(-Math.PI / 2), 180); // south
        });
    });

    describe("VALETUDO_PIXELS_TO_WORLD", () => {
        const head = {minX: -1.5, minY: 2, sizeY: 80};
        const resolution = 0.05;

        it("exactly inverts WORLD_TO_VALETUDO_PIXELS", () => {
            for (const [worldX, worldY] of [[0, 0], [1.23, -4.56], [-1.5, 2], [3.7, 5.9]]) {
                const valetudo = KaercherMapParser.WORLD_TO_VALETUDO_PIXELS(worldX, worldY, head, resolution);
                const roundTripped = KaercherMapParser.VALETUDO_PIXELS_TO_WORLD(
                    valetudo.x, valetudo.y, {minX: head.minX, minY: head.minY, sizeY: head.sizeY, resolution: resolution}
                );

                // WORLD_TO_VALETUDO_PIXELS rounds to whole cm, so the round trip is only
                // exact to within one grid cell (resolution), not bit-for-bit.
                assert.ok(
                    Math.abs(roundTripped.x - worldX) <= resolution,
                    `x: ${roundTripped.x} vs ${worldX}`
                );
                assert.ok(
                    Math.abs(roundTripped.y - worldY) <= resolution,
                    `y: ${roundTripped.y} vs ${worldY}`
                );
            }
        });
    });

    describe("BUILD_VALETUDO_MAP", () => {
        it("builds floor/wall/segment layers matching the documented byte table exactly", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            assert.ok(map, "expected a ValetudoMap, got null");
            assert.deepStrictEqual(map.size, {x: 20, y: 15});
            assert.strictEqual(map.pixelSize, 5);
            assert.strictEqual(map.metaData.vendorMapId, 42);
            assert.deepStrictEqual(map.metaData.worldOrigin, {minX: 0, minY: 0, sizeY: 3, resolution: 0.05});

            // Byte 253 (row 1, col 2) is a carpet cell, split into its own floor
            // layer rather than counted as plain floor (see the carpet test below).
            assert.strictEqual(findLayer(map, "floor").dimensions.pixelCount, 2);
            assert.strictEqual(findLayer(map, "wall").dimensions.pixelCount, 2);

            const seg10 = findLayer(map, "segment", 10);
            assert.strictEqual(seg10.dimensions.pixelCount, 1);
            assert.strictEqual(seg10.metaData.name, "Room A");
            assert.strictEqual(seg10.metaData.material, undefined);

            // Room 14's only cell (byte 192) is a carpet cell, but it must stay in
            // this one plain segment layer — a second, carpet-tagged segment layer
            // sharing the same ID produced a second, wrong-area room label
            // (StructureManager.ts emits one label per segment-type layer, not one
            // per unique segment ID). The carpet is instead an entity, see below.
            const seg14 = findLayer(map, "segment", 14);
            assert.strictEqual(seg14.dimensions.pixelCount, 1);
            assert.strictEqual(seg14.metaData.name, "Room B");
            assert.strictEqual(seg14.metaData.material, undefined);

            const seg15 = findLayer(map, "segment", 15);
            assert.strictEqual(seg15.dimensions.pixelCount, 1);
            assert.strictEqual(seg15.metaData.name, undefined, "segment 15 has no room_data_info entry");

            assert.strictEqual(map.layers.length, 6); // floor, floor-carpet, wall, segment 10, segment 14, segment 15
        });

        it("gives out-of-room carpet cells their own carpet-textured floor layer", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            const floorCarpet = map.layers.find(l => l.type === "floor" && l.metaData.material === "carpet");
            assert.ok(floorCarpet, "byte 253 (out-of-room carpet) should produce a carpet floor layer");
            assert.strictEqual(floorCarpet.dimensions.pixelCount, 1);

            assert.strictEqual(
                map.layers.find(l => l.type === "segment" && l.metaData.material === "carpet"),
                undefined,
                "in-room carpet must never produce a second segment layer (see the room-labels test above)"
            );
        });

        it("builds a CARPET polygon entity from a room's carpet-cell bounding box", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            // Room 14's only cell is byte 192 at grid (col 1, row 1) -> image coords
            // (1, height-1-1) = (1, 1) -> cm (5, 5) to (10, 10) for a single cell.
            const carpet = map.entities.find(e => e.type === "carpet" && e.metaData.id === "room-14-carpet");
            assert.ok(carpet);
            assert.deepStrictEqual(carpet.points, [5, 5, 10, 5, 10, 10, 5, 10]);
        });

        it("places robot/charger entities and the history path using world->pixel conversion", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            const robot = map.entities.find(e => e.type === "robot_position");
            assert.ok(robot);
            assert.deepStrictEqual(robot.points, [10, 10]);
            assert.strictEqual(robot.metaData.angle, 90); // facing east

            const charger = map.entities.find(e => e.type === "charger_location");
            assert.ok(charger);
            assert.deepStrictEqual(charger.points, [20, 0]);
            assert.strictEqual(charger.metaData.angle, 0); // facing north

            const path = map.entities.find(e => e.type === "path");
            assert.ok(path);
            assert.deepStrictEqual(path.points, [0, 15, 5, 15]);
        });

        it("omits the charger entity when chargeStation is (0, 0) (not placed / unknown)", () => {
            const robotMap = buildRobotMap();
            robotMap.chargeStation = {x: 0, y: 0, phi: 0};

            const map = KaercherMapParser.BUILD_VALETUDO_MAP(robotMap);

            assert.strictEqual(map.entities.find(e => e.type === "charger_location"), undefined);
        });

        it("dedupes a wall's duplicated point pairs into a single 2-point line entity", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            const walls = map.entities.filter(e => e.type === "virtual_wall");
            // Without deduping, points[0..3] (the frontend's only read range for a
            // wall) would be the duplicated first point twice -> an invisible
            // zero-length line. This is the regression this fix guards against.
            assert.strictEqual(walls.length, 1);
            assert.deepStrictEqual(walls[0].points, [0, 15, 10, 5]);
        });

        it("splits a wall with more than 2 distinct points into one line entity per segment", () => {
            const robotMap = buildRobotMap();
            robotMap.virtualWalls = [
                {type: 2, areaIndex: 1, points: [{x: 0, y: 0}, {x: 0.05, y: 0}, {x: 0.05, y: 0.05}]}
            ];

            const map = KaercherMapParser.BUILD_VALETUDO_MAP(robotMap);

            const walls = map.entities.filter(e => e.type === "virtual_wall");
            assert.strictEqual(walls.length, 2, "3 distinct points -> 2 connected segments");
            assert.deepStrictEqual(walls[0].points, [0, 15, 5, 15]);
            assert.deepStrictEqual(walls[1].points, [5, 15, 5, 10]);
        });

        it("expands a 2-point no-go zone into a diagonal rectangle, and keeps a 3+ point no-mop zone as-is", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            const noGoAreas = map.entities.filter(e => e.type === "no_go_area");
            assert.strictEqual(noGoAreas.length, 2, "the 2-point no-go entry, plus the unknown-type fallback");
            assert.deepStrictEqual(noGoAreas[0].points, [0, 15, 10, 15, 10, 10, 0, 10]);
            assert.deepStrictEqual(noGoAreas[0].metaData, {id: "2"});
            assert.deepStrictEqual(noGoAreas[1].metaData, {id: "4"}, "type 99 is unmapped and must fall back to no-go, not be dropped");

            const noMopAreas = map.entities.filter(e => e.type === "no_mop_area");
            assert.strictEqual(noMopAreas.length, 1);
            assert.deepStrictEqual(noMopAreas[0].points, [0, 15, 5, 15, 5, 10]);
        });

        it("builds a carpet polygon from furniture_info, using only the first 4 points and ignoring non-carpet furniture", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            // 2 total: 1 from furniture_info (below) + 1 from room 14's grid-byte
            // carpet cell (its own test above) — typeId 999 is furniture, not a
            // carpet, and must be excluded from both sources.
            const carpets = map.entities.filter(e => e.type === "carpet");
            assert.strictEqual(carpets.length, 2);

            const furnitureCarpet = carpets.find(c => c.metaData.id === "7");
            assert.ok(furnitureCarpet);
            assert.deepStrictEqual(furnitureCarpet.points, [5, 15, 10, 15, 10, 10, 5, 10]);
        });

        it("builds obstacle markers from AI-detected objects, filtering out the carpet-duplicate type", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap());

            const obstacles = map.entities.filter(e => e.type === "obstacle");
            assert.strictEqual(obstacles.length, 2, "objectTypeId 1005 duplicates the furniture_info carpet and must be excluded");

            const shoe = obstacles.find(o => o.metaData.id === "5");
            assert.deepStrictEqual(shoe.points, [10, 5]);
            assert.strictEqual(shoe.metaData.label, "Shoe");

            const unknown = obstacles.find(o => o.metaData.id === "6");
            assert.strictEqual(unknown.metaData.label, "Object type 9999");
        });

        it("returns null when the grid payload length doesn't match sizeX*sizeY", () => {
            const robotMap = buildRobotMap();
            robotMap.mapData.mapData = Buffer.from([0, 1, 2]); // too short for 4x3

            assert.strictEqual(KaercherMapParser.BUILD_VALETUDO_MAP(robotMap), null);
        });

        it("returns null when mapHead has non-positive dimensions", () => {
            const robotMap = buildRobotMap();
            robotMap.mapHead.sizeX = 0;

            assert.strictEqual(KaercherMapParser.BUILD_VALETUDO_MAP(robotMap), null);
        });

        it("marks the room clean's rooms active and no others", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(buildRobotMap(), {activeSegmentIds: [10]});

            assert.strictEqual(findLayer(map, "segment", 10).metaData.active, true);
            assert.strictEqual(findLayer(map, "segment", 14).metaData.active, undefined);
        });

        it("adds currentSegmentId only while tracking the current room", () => {
            const robotMap = withPath(buildRobotMap(), [[ROOM_10, 5, 1]]);

            assert.strictEqual(KaercherMapParser.BUILD_VALETUDO_MAP(robotMap).metaData.currentSegmentId, undefined);
            assert.strictEqual(
                KaercherMapParser.BUILD_VALETUDO_MAP(robotMap, {trackCurrentRoom: true}).metaData.currentSegmentId,
                "10"
            );
        });
    });

    describe("CURRENT_SEGMENT_ID", () => {
        it("switches room only after 5 cleaning points in a row land in the new one", () => {
            assert.strictEqual(
                KaercherMapParser.CURRENT_SEGMENT_ID(withPath(buildRobotMap(), [[ROOM_10, 5, 1], [ROOM_15, 4, 1]]), []),
                10
            );
            assert.strictEqual(
                KaercherMapParser.CURRENT_SEGMENT_ID(withPath(buildRobotMap(), [[ROOM_10, 5, 1], [ROOM_15, 5, 1]]), []),
                15
            );
        });

        it("skips transit points and falls back to the robot's position", () => {
            const robotMap = withPath(buildRobotMap(), [[ROOM_10, 5, 0]]);
            robotMap.currentPose = {x: ROOM_14.x, y: ROOM_14.y, phi: 0};

            assert.strictEqual(KaercherMapParser.CURRENT_SEGMENT_ID(robotMap, []), 14);
        });

        it("ignores rooms outside the room clean", () => {
            const robotMap = withPath(buildRobotMap(), [[ROOM_10, 5, 1], [ROOM_15, 5, 1]]);
            robotMap.currentPose = {x: ROOM_14.x, y: ROOM_14.y, phi: 0};

            assert.strictEqual(KaercherMapParser.CURRENT_SEGMENT_ID(robotMap, [10]), 10);
            assert.strictEqual(KaercherMapParser.CURRENT_SEGMENT_ID(withPath(buildRobotMap(), []), [15]), undefined);
        });
    });
});

// Cell centres in world metres for buildRobotMap()'s grid
const ROOM_10 = {x: 0.175, y: 0.025};
const ROOM_14 = {x: 0.075, y: 0.075};
const ROOM_15 = {x: 0.025, y: 0.075};

/**
 * @param {object} robotMap
 * @param {Array<[{x: number, y: number}, number, number]>} runs [cell, point count, update flag]
 * @return {object}
 */
function withPath(robotMap, runs) {
    robotMap.historyPose.points = runs.flatMap(([cell, count, update]) => {
        return Array.from({length: count}, () => {
            return {x: cell.x, y: cell.y, update: update};
        });
    });

    return robotMap;
}
