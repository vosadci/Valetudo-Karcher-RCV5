const KaercherConst = require("./KaercherConst");
const KaercherMapCrypto = require("./KaercherMapCrypto");
const Logger = require("../../Logger");
const mapEntities = require("../../entities/map");
const Protobufs = require("./generated/karcher_protobufs.js");

/**
 * Parses a raw map upload (the PUT body received by KaercherAiotDummycloud's
 * /_valetudo/karcherUpload for a map/temp/_1 object) into a Valetudo ValetudoMap.
 *
 * Wire format, outer to inner (see project_rcv5_valetudo_step7_live_confirmed memory
 * and doc/MAP_DATA.md §3/§4.2 in the karcher-rcv5-ha repo):
 *   PUT body (base64 text) -> AES-128-ECB decrypt -> zlib inflate -> RobotMap protobuf
 *   -> RobotMap.mapData.mapData: bare width*height grid bytes, full-resolution
 *      1-byte-per-cell format, no header (confirmed against a real fixture fetched via
 *      karcher-home: byte count matched size_x*size_y exactly, no room for the 6-byte
 *      header doc/PROTOCOL.md §13.3 describes for the separate upload_by_mapid MQTT
 *      channel — that header belongs to a different, QuickLZ-compressed delivery path).
 *
 * Only the `_1` temp suffix is parsed (confirmed authoritative: it's the one carrying
 * current_pose/history_pose and the newest map_upload_date; `_2` is an older,
 * pose-less snapshot with identical grid data; `_3` was empty in the one account
 * tested). `_2`/`_3` are not handled here — see KaercherAiotDummycloud's upload route.
 *
 * Also builds virtual walls / no-go / no-mop overlays (`virtualWalls`), a carpet
 * texture on affected floor/segment cells (grid bytes, see DECODE_CELL), area
 * carpets from `furnitureInfo` (present on some other Kärcher models, empty on
 * every RCV5 capture taken so far), and AI-detected obstacle markers (`objects`)
 * — ported from the karcher-rcv5-ha HA integration's map_parser.py/map_render.py,
 * which already renders these correctly against a real account/device (that
 * repo's doc/MAP_DATA.md §6.4/§6.7). `areasInfo` (field 10) is deliberately never
 * read: it's the currently-drawn zone-clean rectangle, not a restriction, and the
 * HA integration found the hard way that treating it as one renders a phantom
 * no-go zone.
 */
class KaercherMapParser {
    /**
     * @param {object} options
     * @param {string} options.sn
     * @param {string} options.mac
     * @param {string} options.productId
     */
    constructor(options) {
        this.sn = options.sn;
        this.mac = options.mac;
        this.productId = options.productId;
    }

    /**
     * @param {Buffer} rawUploadBody
     * @return {import("../../entities/map/ValetudoMap")|null}
     */
    parse(rawUploadBody) {
        const robotMap = this.decode(rawUploadBody);

        return robotMap ? KaercherMapParser.BUILD_VALETUDO_MAP(robotMap) : null;
    }

    /**
     * Decrypts and decodes an upload without building the Valetudo map, so the robot can
     * keep it and rebuild the map when the cleaning state changes between uploads.
     *
     * @param {Buffer} rawUploadBody
     * @return {object|null} decoded RobotMap protobuf message
     */
    decode(rawUploadBody) {
        let robotMap;
        try {
            // The PUT body is assumed to be base64 text, not raw binary — inferred from
            // karcher-home's decrypt_map() base64-decoding a GET download of the same
            // S3 object, and corroborated end-to-end: that GET+decrypt+decompress+
            // protobuf-parse chain was verified this session against a real map fetched
            // from the live cloud account, producing sensible content matching
            // doc/MAP_DATA.md §4.2's byte table exactly. Not yet confirmed byte-for-byte
            // on an actual PUT body from the robot itself.
            const bodyText = rawUploadBody.toString("utf-8");
            const decrypted = KaercherMapCrypto.DECRYPT_MAP(
                this.sn, this.mac, this.productId, bodyText
            );

            robotMap = Protobufs.decodeRobotMap(decrypted);
        } catch (e) {
            Logger.warn("KaercherMapParser: failed to decrypt/decode map upload", e);
            return null;
        }

        if (!robotMap.mapHead || !robotMap.mapData?.mapData) {
            Logger.warn("KaercherMapParser: map upload missing mapHead or mapData");
            return null;
        }

        return robotMap;
    }

    /**
     * The robot's map data never says which rooms a clean covers or which room it is in
     * (RoomDataInfo cleanState stays 0, live 2026-10-02), so the robot class passes both in:
     * - activeSegmentIds: the rooms of the room clean Valetudo started. Marked `active`,
     *   which upstream means "part of the current cleanup" (Roborock, Dreame).
     * - trackCurrentRoom: set while cleaning. Adds metaData.currentSegmentId, the room the
     *   robot is cleaning right now, see CURRENT_SEGMENT_ID.
     *
     * @param {object} robotMap decoded RobotMap protobuf message
     * @param {object} [cleanState]
     * @param {Array<number>} [cleanState.activeSegmentIds]
     * @param {boolean} [cleanState.trackCurrentRoom]
     * @return {import("../../entities/map/ValetudoMap")|null}
     */
    static BUILD_VALETUDO_MAP(robotMap, cleanState = {}) {
        const activeSegmentIds = cleanState.activeSegmentIds ?? [];
        const head = robotMap.mapHead;
        const width = head.sizeX;
        const height = head.sizeY;
        const resolution = head.resolution;
        const gridBytes = robotMap.mapData.mapData;

        if (!(width > 0 && height > 0 && resolution > 0)) {
            Logger.warn(`KaercherMapParser: invalid map_head ${JSON.stringify(head)}`);
            return null;
        }
        if (gridBytes.length !== width * height) {
            Logger.warn(
                `KaercherMapParser: grid payload length ${gridBytes.length} != ${width}*${height}`
            );
            return null;
        }

        const pixels = {floor: [], floorCarpet: [], wall: [], segments: {}};
        // In-room carpet cells stay in their room's single segment layer (a second,
        // same-ID segment layer would draw a second room label with its own, much
        // smaller area — Valetudo's frontend emits one label per segment-type layer,
        // not one per unique segment ID, see StructureManager.ts). Instead, just the
        // bounding box of each room's carpet cells is tracked here, and rendered
        // below as a CARPET polygon entity overlaid on top of the room.
        const segmentCarpetBounds = {};

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const cell = KaercherMapParser.DECODE_CELL(gridBytes[(row * width) + col]);
                if (cell.kind === "skip") {
                    continue;
                }

                // Image Y-axis is flipped relative to grid rows (doc/MAP_DATA.md §5):
                // grid row 0 = world min_y = image bottom.
                const coords = [col, height - 1 - row];

                if (cell.kind === "wall") {
                    pixels.wall.push(coords);
                } else if (cell.kind === "floor") {
                    (cell.carpet ? pixels.floorCarpet : pixels.floor).push(coords);
                } else {
                    (pixels.segments[cell.segmentId] ??= []).push(coords);

                    if (cell.carpet) {
                        segmentCarpetBounds[cell.segmentId] ??= {
                            minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity
                        };
                        const bounds = segmentCarpetBounds[cell.segmentId];
                        bounds.minX = Math.min(bounds.minX, coords[0]);
                        bounds.maxX = Math.max(bounds.maxX, coords[0]);
                        bounds.minY = Math.min(bounds.minY, coords[1]);
                        bounds.maxY = Math.max(bounds.maxY, coords[1]);
                    }
                }
            }
        }

        const layers = [];

        if (pixels.floor.length > 0) {
            layers.push(new mapEntities.MapLayer({
                pixels: pixels.floor.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                type: mapEntities.MapLayer.TYPE.FLOOR
            }));
        }
        if (pixels.floorCarpet.length > 0) {
            layers.push(new mapEntities.MapLayer({
                pixels: pixels.floorCarpet.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                type: mapEntities.MapLayer.TYPE.FLOOR,
                metaData: {material: mapEntities.MapLayer.MATERIAL.CARPET}
            }));
        }
        if (pixels.wall.length > 0) {
            layers.push(new mapEntities.MapLayer({
                pixels: pixels.wall.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                type: mapEntities.MapLayer.TYPE.WALL
            }));
        }

        const roomsById = new Map((robotMap.roomDataInfo ?? []).map(r => [r.roomId, r]));
        Object.keys(pixels.segments).forEach((segmentIdStr) => {
            const segmentId = parseInt(segmentIdStr, 10);
            const room = roomsById.get(segmentId);
            const metaData = {segmentId: segmentIdStr};
            if (room?.roomName) {
                metaData.name = room.roomName;
            }

            // `meterialId` (map protobuf RoomDataInfo field 4, APK's own typo) is a
            // robot-derived AI floor classification, not the app's set_preference field of
            // the same name — the app never writes it, only ever displays it as a binary
            // "smooth" texture. Live-confirmed (2026-09-28) to report real, distinct,
            // non-default values per room. Values per firmware AI_FLOOR_* disassembly /
            // APK MapTypeKt.java: 1=concrete/smooth, 2=tile, 3=wood, 10=carpet; 0 or absent
            // means unset/unknown, left unmapped rather than guessed at.
            const material = KaercherMapParser.MATERIAL_ID_TO_VALETUDO[room?.meterialId];
            if (material !== undefined) {
                metaData.material = material;
            }
            if (activeSegmentIds.includes(segmentId)) {
                metaData.active = true;
            }

            layers.push(new mapEntities.MapLayer({
                pixels: pixels.segments[segmentIdStr].sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                type: mapEntities.MapLayer.TYPE.SEGMENT,
                metaData: metaData
            }));
        });

        if (layers.length === 0) {
            Logger.warn("KaercherMapParser: no decodable pixels in this map upload");
            return null;
        }

        const entities = [];
        const toValetudo = (x, y) => KaercherMapParser.WORLD_TO_VALETUDO_PIXELS(x, y, head, resolution);

        if (robotMap.currentPose) {
            const {x, y, phi} = robotMap.currentPose;
            entities.push(new mapEntities.PointMapEntity({
                points: [toValetudo(x, y).x, toValetudo(x, y).y],
                metaData: {angle: KaercherMapParser.PHI_TO_VALETUDO_ANGLE(phi ?? 0)},
                type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION
            }));
        }

        if (robotMap.chargeStation && (robotMap.chargeStation.x !== 0 || robotMap.chargeStation.y !== 0)) {
            const {x, y, phi} = robotMap.chargeStation;
            entities.push(new mapEntities.PointMapEntity({
                points: [toValetudo(x, y).x, toValetudo(x, y).y],
                metaData: {angle: KaercherMapParser.PHI_TO_VALETUDO_ANGLE(phi ?? 0)},
                type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION
            }));
        }

        const historyPoints = robotMap.historyPose?.points ?? [];
        if (historyPoints.length > 0) {
            const pathPoints = [];
            historyPoints.forEach((p) => {
                const c = toValetudo(p.x, p.y);
                pathPoints.push(c.x, c.y);
            });

            entities.push(new mapEntities.PathMapEntity({
                points: pathPoints,
                type: mapEntities.PathMapEntity.TYPE.PATH
            }));
        }

        (robotMap.virtualWalls ?? []).forEach((zone) => {
            const points = (zone.points ?? []).map(p => toValetudo(p.x, p.y));

            if (zone.type === KaercherConst.ZONE_TYPE_WALL) {
                // Device-confirmed 2026-09-20 (real RCV5 capture): the robot sends a
                // wall's points as duplicated pairs, e.g. [A, A, B, B], not the plain
                // [A, B] the APK-derived doc implied. Valetudo's frontend draws a
                // VIRTUAL_WALL LineMapEntity from only its first two points, so an
                // un-deduped [A, A, ...] renders a zero-length (invisible) line.
                // Collapse consecutive duplicates first, then emit one LineMapEntity
                // per remaining segment, in case a wall ever has more than 2 distinct
                // points (the frontend only draws 2 points per entity, so an N-point
                // polyline needs N-1 separate entities to render as connected segments).
                const distinctPoints = points.filter((p, i) => {
                    return i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y;
                });
                for (let i = 0; i < distinctPoints.length - 1; i++) {
                    entities.push(new mapEntities.LineMapEntity({
                        points: [distinctPoints[i].x, distinctPoints[i].y, distinctPoints[i + 1].x, distinctPoints[i + 1].y],
                        type: mapEntities.LineMapEntity.TYPE.VIRTUAL_WALL,
                        metaData: {id: String(zone.areaIndex)}
                    }));
                }
                return;
            }

            // A 2-point area is two diagonal rectangle corners, not a degenerate
            // polygon — same convention the app itself draws it with.
            let corners = points;
            if (points.length === 2) {
                const [p0, p1] = points;
                corners = [p0, {x: p1.x, y: p0.y}, p1, {x: p0.x, y: p1.y}];
            }
            if (corners.length < 3) {
                return;
            }

            entities.push(new mapEntities.PolygonMapEntity({
                points: corners.flatMap(p => [p.x, p.y]),
                // Unknown/unmapped type codes intentionally fall through to
                // NO_GO_AREA here too, so an area still surfaces even for a type
                // this robot hasn't been seen sending yet.
                type: zone.type === KaercherConst.ZONE_TYPE_NOMOP ?
                    mapEntities.PolygonMapEntity.TYPE.NO_MOP_AREA :
                    mapEntities.PolygonMapEntity.TYPE.NO_GO_AREA,
                metaData: {id: String(zone.areaIndex)}
            }));
        });

        // Bounding-box CARPET overlay for each room's carpet cells (see
        // segmentCarpetBounds above). Grid coordinates are cell indices, matching
        // the raw units MapLayer.pixels use; entity points use cm (cell index *
        // PIXEL_SIZE, the same scale toValetudo() applies), so that conversion has
        // to happen here rather than reusing the raw coords collected above. +1 on
        // the max corner includes the far edge of the last cell, not just its
        // near corner.
        Object.keys(segmentCarpetBounds).forEach((segmentIdStr) => {
            const bounds = segmentCarpetBounds[segmentIdStr];
            const x0 = bounds.minX * KaercherMapParser.PIXEL_SIZE;
            const x1 = (bounds.maxX + 1) * KaercherMapParser.PIXEL_SIZE;
            const y0 = bounds.minY * KaercherMapParser.PIXEL_SIZE;
            const y1 = (bounds.maxY + 1) * KaercherMapParser.PIXEL_SIZE;

            entities.push(new mapEntities.PolygonMapEntity({
                points: [x0, y0, x1, y0, x1, y1, x0, y1],
                type: mapEntities.PolygonMapEntity.TYPE.CARPET,
                metaData: {id: `room-${segmentIdStr}-carpet`}
            }));
        });

        (robotMap.furnitureInfo ?? []).forEach((item) => {
            if (item.typeId !== KaercherConst.FURNITURE_CARPET_TYPE_ID) {
                return;
            }

            // The app itself only ever consumes the first four points of an entry
            // as a quad; further points are ignored, so we must do the same.
            const points = (item.points ?? []).slice(0, 4).map(p => toValetudo(p.x, p.y));
            if (points.length < 3) {
                return;
            }

            entities.push(new mapEntities.PolygonMapEntity({
                points: points.flatMap(p => [p.x, p.y]),
                type: mapEntities.PolygonMapEntity.TYPE.CARPET,
                metaData: {id: String(item.id)}
            }));
        });

        (robotMap.objects ?? []).forEach((object) => {
            if (object.objectTypeId === KaercherConst.OBJECT_TYPE_CARPET) {
                // Duplicates the area-carpet polygon from furniture_info above.
                return;
            }

            const {x, y} = toValetudo(object.x, object.y);
            entities.push(new mapEntities.PointMapEntity({
                points: [x, y],
                type: mapEntities.PointMapEntity.TYPE.OBSTACLE,
                metaData: {
                    id: String(object.objectId),
                    label: KaercherConst.AI_OBJECT_TYPE_LABELS[object.objectTypeId] ??
                        `Object type ${object.objectTypeId}`
                }
            }));
        });

        const mapMetaData = {
            vendorMapId: head.mapHeadId,
            // Cached so a later zone-cleaning command can invert
            // WORLD_TO_VALETUDO_PIXELS back to the robot's native world-metre
            // coordinates for the map currently on screen — head/resolution are
            // per-upload and don't survive past this function otherwise.
            worldOrigin: {minX: head.minX, minY: head.minY, sizeY: head.sizeY, resolution: resolution}
        };

        if (cleanState.trackCurrentRoom) {
            const currentSegmentId = KaercherMapParser.CURRENT_SEGMENT_ID(robotMap, activeSegmentIds);

            if (currentSegmentId !== undefined) {
                mapMetaData.currentSegmentId = String(currentSegmentId);
            }
        }

        return new mapEntities.ValetudoMap({
            metaData: mapMetaData,
            size: {
                x: width * KaercherMapParser.PIXEL_SIZE,
                y: height * KaercherMapParser.PIXEL_SIZE
            },
            pixelSize: KaercherMapParser.PIXEL_SIZE,
            layers: layers,
            entities: entities
        });
    }

    /**
     * Decodes a single grid byte per doc/MAP_DATA.md §4.2/§6.4 (APK-verified, and
     * confirmed this session against a real fixture: byte value distribution matched
     * exactly, including room-id values lining up 1:1 with room_data_info entries).
     *
     * Carpet (rugs) on the RCV5 is NOT carried by `furniture_info` (field 16) —
     * live captures show that array empty even while the app renders a rug the
     * user can see. It's encoded directly in these grid bytes instead: 147-196
     * inside a room, 253 outside any room (doc/MAP_DATA.md §6.4). `furniture_info`
     * parsing is kept below for other Kärcher models that may use it, but it's a
     * no-op on every RCV5 capture taken so far.
     *
     * Out-of-room carpet cells (253) get their own FLOOR-type MapLayer with a
     * carpet material, same as any other vendor's floor-material overlay. In-room
     * carpet cells (147-196) do NOT get a second SEGMENT-type layer for their
     * room — Valetudo's frontend renders one room label per segment-type layer,
     * not one per unique segment ID, so a second layer sharing the room's ID
     * produced a second, wrong-area label for that room (live-confirmed
     * 2026-09-21). In-room carpet cells stay merged into their room's one
     * segment layer and are instead rendered as a CARPET polygon entity — see
     * `segmentCarpetBounds` in BUILD_VALETUDO_MAP.
     *
     * @param {number} byte
     * @return {{kind: "wall"|"floor"|"segment"|"skip", segmentId?: number, carpet?: boolean}}
     */
    static DECODE_CELL(byte) {
        if (byte === 255) {
            return {kind: "wall"};
        }
        if (byte === 253) {
            // Carpet/second-pass cell outside any room.
            return {kind: "floor", carpet: true};
        }
        if (byte >= 10 && byte <= 59) {
            // Unvisited room cell.
            return {kind: "segment", segmentId: byte};
        }
        if (byte >= 60 && byte <= 127) {
            // Cleaned room cell.
            return {kind: "segment", segmentId: byte - 50};
        }
        if (byte >= 147 && byte <= 196) {
            // Carpet/second-pass room cell.
            return {kind: "segment", segmentId: 206 - byte, carpet: true};
        }
        if (byte < 10) {
            switch (byte & 0x3) {
                case 1: // cleaned
                case 2: // deep-cleaned
                    return {kind: "floor"};
                case 3: // wall
                    return {kind: "wall"};
                default: // 0: free/unknown
                    return {kind: "skip"};
            }
        }
        // 128-146, 197-252, 254: unhandled by the app itself, no colour assigned.
        return {kind: "skip"};
    }

    /**
     * The room the robot is cleaning, as the karcher-rcv5-ha integration works it out
     * (coordinator._track_room_transition): replay the cleaning path, skip points flagged
     * as transit (update 0, doc/PROTOCOL.md §13.1), and switch room only after
     * CURRENT_ROOM_HYSTERESIS points in a row land in the new one, so brief trips through
     * a doorway don't count. Rooms outside the current room clean are ignored. Falls back
     * to the robot's own position when the path gives no room yet.
     *
     * @param {object} robotMap decoded RobotMap protobuf message
     * @param {Array<number>} allowedSegmentIds empty = any room
     * @return {number|undefined}
     */
    static CURRENT_SEGMENT_ID(robotMap, allowedSegmentIds) {
        const head = robotMap.mapHead;
        const gridBytes = robotMap.mapData.mapData;
        // Grid row 0 is world minY, so no image flip here (same lookup as the integration's
        // map_render.room_id_for_world_point)
        const segmentAt = (x, y) => {
            const col = Math.floor((x - head.minX) / head.resolution);
            const row = Math.floor((y - head.minY) / head.resolution);

            if (col < 0 || row < 0 || col >= head.sizeX || row >= head.sizeY) {
                return undefined;
            }

            const cell = KaercherMapParser.DECODE_CELL(gridBytes[(row * head.sizeX) + col]);

            if (cell.kind !== "segment") {
                return undefined;
            }
            if (allowedSegmentIds.length > 0 && !allowedSegmentIds.includes(cell.segmentId)) {
                return undefined;
            }

            return cell.segmentId;
        };

        const points = robotMap.historyPose?.points ?? [];
        let current;
        let candidate;
        let candidateCount = 0;
        let cleaningPoints = 0;

        points.forEach((point) => {
            if (!point.update) {
                return;
            }
            cleaningPoints++;

            const segmentId = segmentAt(point.x, point.y);

            if (segmentId === undefined) {
                return;
            }

            if (segmentId === current) {
                candidate = undefined;
                candidateCount = 0;
            } else if (segmentId === candidate) {
                candidateCount++;

                if (candidateCount >= KaercherMapParser.CURRENT_ROOM_HYSTERESIS) {
                    current = segmentId;
                    candidate = undefined;
                    candidateCount = 0;
                }
            } else {
                candidate = segmentId;
                candidateCount = 1;
            }
        });

        // Not yet confirmed live that historyPose's `update` carries the same cleaning flag as cur_path's
        Logger.debug(`KaercherMapParser: path has ${cleaningPoints} cleaning and ${points.length - cleaningPoints} transit points`);

        if (current === undefined && robotMap.currentPose) {
            current = segmentAt(robotMap.currentPose.x, robotMap.currentPose.y);
        }

        return current;
    }

    /**
     * World metres (doc/MAP_DATA.md §5: origin bottom-left, Y up) to Valetudo pixel
     * coordinates (origin top-left, Y down, units of PIXEL_SIZE cm).
     *
     * @param {number} worldX
     * @param {number} worldY
     * @param {{sizeY: number, minX: number, minY: number}} head
     * @param {number} resolution metres/cell
     * @return {{x: number, y: number}}
     */
    static WORLD_TO_VALETUDO_PIXELS(worldX, worldY, head, resolution) {
        const col = (worldX - head.minX) / resolution;
        const rowFromBottom = (worldY - head.minY) / resolution;

        return {
            x: Math.round(col * KaercherMapParser.PIXEL_SIZE),
            y: Math.round((head.sizeY - rowFromBottom) * KaercherMapParser.PIXEL_SIZE)
        };
    }

    /**
     * Exact inverse of WORLD_TO_VALETUDO_PIXELS, for turning a zone the user drew on
     * Valetudo's own map (cm, origin top-left, Y down) back into the robot's native
     * world metres (origin bottom-left, Y up) for `set_zone_points`.
     *
     * @param {number} valetudoX cm
     * @param {number} valetudoY cm
     * @param {{minX: number, minY: number, sizeY: number, resolution: number}} worldOrigin
     *   as cached on ValetudoMap.metaData.worldOrigin by BUILD_VALETUDO_MAP
     * @return {{x: number, y: number}} world metres
     */
    static VALETUDO_PIXELS_TO_WORLD(valetudoX, valetudoY, worldOrigin) {
        const col = valetudoX / KaercherMapParser.PIXEL_SIZE;
        const rowFromBottom = worldOrigin.sizeY - (valetudoY / KaercherMapParser.PIXEL_SIZE);

        return {
            x: (col * worldOrigin.resolution) + worldOrigin.minX,
            y: (rowFromBottom * worldOrigin.resolution) + worldOrigin.minY
        };
    }

    /**
     * Karcher's phi (doc/MAP_DATA.md §5): radians, 0 = east (+X), π/2 = north (+Y), CCW+,
     * in WORLD space. Valetudo's PointMapEntity angle: degrees, 0-360, 0° = north, in
     * (Y-flipped) screen space — same convention every other vendor parser in this repo
     * targets via `(mathDegrees + 90) % 360` (see MideaMapParser/RoborockMapParser). The
     * extra negation here accounts for the world->screen Y-flip that those vendors'
     * raw angle inputs were already expressed in but ours isn't — same transform this
     * project's own HA card uses for the identical phi convention (Kärcher
     * karcher-rcv5-ha `www/card/map-draw.js`: "Canvas target angle for world phi
     * (Y-flipped) = -phi").
     *
     * @param {number} phi radians
     * @return {number} degrees, 0-360, 0 = north
     */
    static PHI_TO_VALETUDO_ANGLE(phi) {
        const degrees = 90 - (phi * 180 / Math.PI);
        return ((degrees % 360) + 360) % 360;
    }
}

KaercherMapParser.PIXEL_SIZE = 5; // cm; matches the RCV5's 0.05m/cell grid resolution
// Same value as the karcher-rcv5-ha integration's _ROOM_CHANGE_HYSTERESIS
KaercherMapParser.CURRENT_ROOM_HYSTERESIS = 5;

// RoomDataInfo.meterialId -> Valetudo MapLayer.MATERIAL. See the comment at its use site
// above. 0/absent (unset/unknown) is deliberately not a key here.
KaercherMapParser.MATERIAL_ID_TO_VALETUDO = {
    1: mapEntities.MapLayer.MATERIAL.GENERIC, // concrete/smooth
    2: mapEntities.MapLayer.MATERIAL.TILE,
    // meterialId carries no plank direction — WOOD_VERTICAL is an arbitrary guess,
    // chosen over plain WOOD (chevron) since straight-plank flooring is far more common
    // than herringbone in practice, and over WOOD_HORIZONTAL by live observation on this
    // unit's own floors.
    3: mapEntities.MapLayer.MATERIAL.WOOD_VERTICAL,
    10: mapEntities.MapLayer.MATERIAL.CARPET
};

module.exports = KaercherMapParser;
