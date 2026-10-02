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
            const robotMap = corridor([[0.2, 1.3, 1]]);

            assert.strictEqual(KaercherMapParser.BUILD_VALETUDO_MAP(robotMap).metaData.currentSegmentId, undefined);
            assert.strictEqual(
                KaercherMapParser.BUILD_VALETUDO_MAP(robotMap, {trackCurrentRoom: true}).metaData.currentSegmentId,
                "10"
            );
        });

        it("reports travelling instead of a room while the robot drives between rooms", () => {
            const map = KaercherMapParser.BUILD_VALETUDO_MAP(corridor([[0.2, 1.3, 1], [1.4, 1.8, 0]]), {trackCurrentRoom: true});

            assert.strictEqual(map.metaData.travelling, true);
            assert.strictEqual(map.metaData.currentSegmentId, undefined);
        });
    });

    describe("CURRENT_ROOM", () => {
        const room = (segmentId) => {
            return {segmentId: segmentId, travelling: false};
        };
        const TRAVELLING = {segmentId: undefined, travelling: true};

        it("stays in the room while the robot cleans into the next room's doorway", () => {
            // 40 cm into room 11, checked at the deepest point and after coming back
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.4, 1], [1.5, 1.9, 1]]), []), room(10));
            assert.deepStrictEqual(
                KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.4, 1], [1.5, 1.9, 1], [1.8, 1.0, 1]]), []),
                room(10)
            );
        });

        it("switches room once the robot is 1 m from where it entered", () => {
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.4, 1], [1.5, 2.4, 1]]), []), room(10));
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.4, 1], [1.5, 2.5, 1]]), []), room(11));
        });

        it("reports travelling, not the room it stands in, before the first cleaning point", () => {
            // Idle in one room, sent to clean others: the drive out is all transit points
            const robotMap = corridor([[0.2, 0.8, 0]]);
            robotMap.currentPose = {x: 0.2, y: 0.025, phi: 0};

            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, []), TRAVELLING);
        });

        it("reports travelling after 5 transit points in a row, but not after fewer", () => {
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.3, 1], [1.4, 1.8, 0]]), []), TRAVELLING);
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.3, 1], [1.4, 1.7, 0]]), []), room(10));
        });

        it("names the first room of the clean, in the order sent, that the path hasn't cleaned yet", () => {
            // Sent order 11, 10, 12; 11 is done, so the robot is heading for 10
            const robotMap = corridor([[1.5, 2.9, 1], [3.0, 3.4, 0]]);

            assert.deepStrictEqual(
                KaercherMapParser.CURRENT_ROOM(robotMap, [11, 10, 12]),
                {segmentId: undefined, travelling: true, nextSegmentId: 10}
            );
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, []), TRAVELLING);
        });

        it("after travelling, the first cleaning point sets the new room", () => {
            const robotMap = corridor([[0.2, 1.3, 1], [1.4, 1.8, 0], [1.9, 2.1, 1]]);

            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, []), room(11));
        });

        it("keeps the first room through a doorway visit before it is 1 m in", () => {
            // Live 2026-10-02: 9 cleaning points into the Bathroom, then 6 in the Hall doorway
            const robotMap = corridor([[1.0, 1.4, 0], [2.1, 2.9, 1], [3.0, 3.5, 1]]);
            robotMap.currentPose = {x: 3.5, y: 0.025, phi: 0};

            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, []), room(11));
        });

        it("doesn't count driving between cleaning strips inside the room as travelling", () => {
            // Live 2026-10-02: 11 transit points in a row inside the Bathroom
            const robotMap = corridor([[0.2, 1.0, 1], [1.1, 0.1, 0]]);

            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, [10, 11]), room(10));
        });

        it("falls back to the robot's position when the path has no points", () => {
            const robotMap = corridor([]);
            robotMap.currentPose = {x: 2.0, y: 0.025, phi: 0};

            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, []), room(11));
        });

        it("ignores rooms outside the room clean", () => {
            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(corridor([[0.2, 1.4, 1], [1.5, 2.9, 1]]), [10]), room(10));

            const robotMap = corridor([]);
            robotMap.currentPose = {x: 0.5, y: 0.025, phi: 0};

            assert.deepStrictEqual(KaercherMapParser.CURRENT_ROOM(robotMap, [11]), room(undefined));
        });
    });
});

/**
 * A 4.5 m corridor, one 5 cm cell high: rooms 10, 11 and 12, 1.5 m each. The robot walks
 * along it in 10 cm steps, as far apart as real path points (live 2026-10-02).
 *
 * @param {Array<[number, number, number]>} legs [from x, to x (both in metres, inclusive), update flag]
 * @return {object}
 */
function corridor(legs) {
    const cells = Array.from({length: 90}, (_, col) => {
        return 10 + Math.floor(col / 30);
    });
    const points = legs.flatMap(([from, to, update]) => {
        // Decimetres, so the steps don't pick up floating point error
        const step = to >= from ? 1 : -1;
        const result = [];

        for (let dm = Math.round(from * 10); dm !== Math.round(to * 10) + step; dm += step) {
            result.push({x: dm / 10, y: 0.025, update: update});
        }

        return result;
    });

    return {
        mapHead: {mapHeadId: 1, sizeX: 90, sizeY: 1, minX: 0, minY: 0, resolution: 0.05},
        mapData: {mapData: Buffer.from(cells)},
        historyPose: {points: points}
    };
}
