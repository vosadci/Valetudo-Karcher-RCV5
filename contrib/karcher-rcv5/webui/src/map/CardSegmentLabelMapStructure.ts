import SegmentLabelMapStructure from "map/structures/map_structures/SegmentLabelMapStructure";
import {Canvas2DContextTrackingWrapper} from "map/utils/Canvas2DContextTrackingWrapper";
import {considerHiDPI} from "map/utils/helpers";
import {RawMapLayerMaterial} from "api";

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, Roboto, Helvetica, Arial, sans-serif";
const PILL_FILL = "rgba(255, 255, 255, 0.7)";
const PILL_FILL_HIGHLIGHT = "rgba(255, 212, 0, 0.75)";
const TEXT_COLOR = "#1b1c1f";

// Replaces SegmentLabelMapStructure for StructureManager (see build.js). Draws the Lovelace card's
// room label: the name in a pill that keeps its size at any zoom, yellow when the room is selected
// or part of the running job. Zoomed in, a second line adds area and id, as upstream's label does. The selection order (Roman number) is a small badge inside the pill.
// Taps, selection and placement stay upstream's.
class CardSegmentLabelMapStructure extends SegmentLabelMapStructure {
    private readonly inJob: boolean;
    private readonly areaCm2: number;

    constructor(
        x0: number,
        y0: number,
        id: string,
        selected: boolean,
        active: boolean,
        area: number,
        name: string | undefined,
        material: RawMapLayerMaterial | undefined
    ) {
        super(x0, y0, id, selected, active, area, name, material);

        this.inJob = active;
        this.areaCm2 = area;
    }

    draw(ctxWrapper: Canvas2DContextTrackingWrapper, transformationMatrixToScreenSpace: DOMMatrixInit, scaleFactor: number): void {
        const ctx = ctxWrapper.getContext();
        const p0 = new DOMPoint(this.x0, this.y0).matrixTransform(transformationMatrixToScreenSpace);
        const text = this.name || this.id;
        const fontSize = considerHiDPI(16);
        const badgeFontSize = considerHiDPI(12);
        // Same zoom threshold and wording as upstream's label
        const detail = scaleFactor >= considerHiDPI(11) ?
            `${(this.areaCm2 / 10000).toPrecision(2)} m² (id=${this.id})` :
            undefined;
        const detailFontSize = considerHiDPI(12);
        const lineHeight = fontSize * 1.25;
        const detailLineHeight = detailFontSize * 1.25;
        const radius = (fontSize * 1.65) / 2;
        const height = (fontSize * 0.4) + lineHeight + (detail ? detailLineHeight : 0);
        const padding = fontSize * 0.9;
        const gap = fontSize * 0.4;

        ctxWrapper.save();
        ctx.textBaseline = "middle";

        ctx.font = `bold ${badgeFontSize}px ${FONT_FAMILY}`;
        const badgeTextWidth = this.topLabel ? ctx.measureText(this.topLabel).width : 0;
        const badgeHeight = badgeFontSize * 1.5;
        const badgeWidth = this.topLabel ? Math.max(badgeHeight, badgeTextWidth + (badgeFontSize * 0.9)) : 0;

        ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
        let textWidth = ctx.measureText(text).width;

        if (detail) {
            ctx.font = `${detailFontSize}px ${FONT_FAMILY}`;
            textWidth = Math.max(textWidth, ctx.measureText(detail).width);
        }
        const badgeInset = padding * 0.6;
        const width = this.topLabel ?
            badgeInset + badgeWidth + gap + textWidth + padding :
            padding + textWidth + padding;
        const left = p0.x - (width / 2);
        const top = p0.y - (height / 2);

        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
        ctx.shadowBlur = considerHiDPI(4);
        ctx.shadowOffsetY = considerHiDPI(1);
        ctx.fillStyle = this.selected || this.inJob ? PILL_FILL_HIGHLIGHT : PILL_FILL;
        roundedRect(ctx, left, top, width, height, radius);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
        ctx.lineWidth = considerHiDPI(1);
        ctx.stroke();

        let textX = left + padding;

        if (this.topLabel) {
            const badgeLeft = left + badgeInset;

            ctx.fillStyle = TEXT_COLOR;
            roundedRect(ctx, badgeLeft, p0.y - (badgeHeight / 2), badgeWidth, badgeHeight, badgeHeight / 2);
            ctx.fill();

            ctx.font = `bold ${badgeFontSize}px ${FONT_FAMILY}`;
            ctx.textAlign = "center";
            ctx.fillStyle = "#ffffff";
            ctx.fillText(this.topLabel, badgeLeft + (badgeWidth / 2), p0.y);

            textX = badgeLeft + badgeWidth + gap;
        }

        ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
        ctx.textAlign = "left";
        ctx.fillStyle = TEXT_COLOR;
        if (detail) {
            const textTop = top + (fontSize * 0.2);

            ctx.fillText(text, textX, textTop + (lineHeight / 2));
            ctx.font = `${detailFontSize}px ${FONT_FAMILY}`;
            ctx.fillText(detail, textX, textTop + lineHeight + (detailLineHeight / 2));
        } else {
            ctx.fillText(text, textX, p0.y);
        }

        ctxWrapper.restore();
    }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
    ctx.beginPath();
    //@ts-ignore
    if (typeof ctx.roundRect === "function") { // Needs at least FF 112
        //@ts-ignore
        ctx.roundRect(x, y, width, height, radius);
    } else {
        ctx.rect(x, y, width, height);
    }
}

export default CardSegmentLabelMapStructure;
