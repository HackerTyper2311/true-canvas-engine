/**
 * canvas.js — Core drawing engine for PubNub-based canvas bots
 *
 * Protocol:
 *   channel: 'coords'
 *   message: { userId, style, x, y, seq }
 *     - x, y  : normalized 0..1 (fraction of receiver's screen width/height)
 *     - style : hex color string, e.g. '#ff00ff'
 *     - seq   : monotonically increasing per-user sequence number
 *
 * Requires: Node.js 18+ (global fetch used by pubnub.js)
 *
 * Quick start:
 *   const Canvas = require('./canvas');
 *   const bot = new Canvas.Artist({ style: '#ff0000' });
 *   await bot.drawLine({ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 });
 */

'use strict';

const PubNub = require('./pubnub.js');

// ─────────────────────────────────────────────────────────────────────────────
// §1  MATH UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp `v` to [min, max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * Random float in [min, max).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const rand = (min, max) => min + Math.random() * (max - min);

/**
 * Promisified setTimeout.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Linear interpolation between two scalars.
 * @param {number} a
 * @param {number} b
 * @param {number} t  0..1
 * @returns {number}
 */
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Degrees → radians.
 * @param {number} deg
 * @returns {number}
 */
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Radians → degrees.
 * @param {number} rad
 * @returns {number}
 */
const toDeg = (rad) => (rad * 180) / Math.PI;

// ─────────────────────────────────────────────────────────────────────────────
// §2  VEC2 — immutable-style 2-D vector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 2-D vector with common math operations.
 * All arithmetic methods return a NEW Vec2 (non-mutating).
 */
class Vec2 {
    /**
     * @param {number} [x=0]
     * @param {number} [y=0]
     */
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }

    /** Return a copy of this vector. */
    clone() { return new Vec2(this.x, this.y); }

    /** Component-wise addition. */
    add(v) { return new Vec2(this.x + v.x, this.y + v.y); }

    /** Component-wise subtraction. */
    sub(v) { return new Vec2(this.x - v.x, this.y - v.y); }

    /** Scalar multiplication. */
    scale(s) { return new Vec2(this.x * s, this.y * s); }

    /** Component-wise multiplication. */
    mul(v) { return new Vec2(this.x * v.x, this.y * v.y); }

    /** Dot product. */
    dot(v) { return this.x * v.x + this.y * v.y; }

    /** 2-D cross product (scalar z-component). */
    cross(v) { return this.x * v.y - this.y * v.x; }

    /** Euclidean length. */
    length() { return Math.hypot(this.x, this.y); }

    /** Squared length (cheaper than length()). */
    lengthSq() { return this.x * this.x + this.y * this.y; }

    /** Euclidean distance to another vector. */
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y); }

    /** Angle of this vector (radians, from +x axis). */
    angle() { return Math.atan2(this.y, this.x); }

    /** Angle from this point toward another (radians). */
    angleTo(v) { return Math.atan2(v.y - this.y, v.x - this.x); }

    /** Unit vector. Returns (0,0) if length is zero. */
    normalize() {
        const len = this.length();
        return len === 0 ? new Vec2(0, 0) : this.scale(1 / len);
    }

    /**
     * Rotate around the origin by `angle` radians.
     * @param {number} angle  Radians.
     */
    rotate(angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return new Vec2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
    }

    /**
     * Rotate around a pivot point.
     * @param {Vec2}   pivot
     * @param {number} angle  Radians.
     */
    rotateAround(pivot, angle) {
        return this.sub(pivot).rotate(angle).add(pivot);
    }

    /** Linear interpolation toward `v` at parameter `t` (0..1). */
    lerp(v, t) { return new Vec2(lerp(this.x, v.x, t), lerp(this.y, v.y, t)); }

    /**
     * Reflect this vector across a normal `n` (must be unit length).
     * @param {Vec2} n  Unit normal.
     */
    reflect(n) { return this.sub(n.scale(2 * this.dot(n))); }

    /** Perpendicular vector (rotated 90° CCW). */
    perp() { return new Vec2(-this.y, this.x); }

    /**
     * Project this vector onto `v`.
     * @param {Vec2} v
     */
    projectOnto(v) {
        const d = v.dot(v);
        return d === 0 ? new Vec2(0, 0) : v.scale(this.dot(v) / d);
    }

    /** Equality check within an optional epsilon. */
    equals(v, eps = 1e-9) {
        return Math.abs(this.x - v.x) <= eps && Math.abs(this.y - v.y) <= eps;
    }

    toString() { return `Vec2(${this.x.toFixed(4)}, ${this.y.toFixed(4)})`; }

    /**
     * Create a Vec2 from any {x,y} object.
     * @param {{ x: number, y: number }} obj
     * @returns {Vec2}
     */
    static from(obj) { return new Vec2(obj.x, obj.y); }

    /**
     * Create a unit vector pointing at `angle` radians.
     * @param {number} angle
     * @returns {Vec2}
     */
    static fromAngle(angle) { return new Vec2(Math.cos(angle), Math.sin(angle)); }

    /** Zero vector. */
    static get ZERO() { return new Vec2(0, 0); }

    /** (1, 0) */
    static get RIGHT() { return new Vec2(1, 0); }

    /** (0, 1) */
    static get DOWN() { return new Vec2(0, 1); }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  VEC3 — 3-D vector with projection helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3-D vector with common operations and built-in 3-D→2-D projection.
 * All arithmetic methods return a new Vec3 (non-mutating).
 */
class Vec3 {
    /**
     * @param {number} [x=0]
     * @param {number} [y=0]
     * @param {number} [z=0]
     */
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    clone() { return new Vec3(this.x, this.y, this.z); }

    add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
    sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
    scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }

    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }

    cross(v) {
        return new Vec3(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z,
            this.x * v.y - this.y * v.x,
        );
    }

    length() { return Math.hypot(this.x, this.y, this.z); }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }

    normalize() {
        const len = this.length();
        return len === 0 ? new Vec3(0, 0, 0) : this.scale(1 / len);
    }

    lerp(v, t) { return new Vec3(lerp(this.x, v.x, t), lerp(this.y, v.y, t), lerp(this.z, v.z, t)); }

    /**
     * Rotate around the X axis by `angle` radians.
     * @param {number} angle
     */
    rotateX(angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return new Vec3(this.x, this.y * cos - this.z * sin, this.y * sin + this.z * cos);
    }

    /**
     * Rotate around the Y axis by `angle` radians.
     * @param {number} angle
     */
    rotateY(angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return new Vec3(this.x * cos + this.z * sin, this.y, -this.x * sin + this.z * cos);
    }

    /**
     * Rotate around the Z axis by `angle` radians.
     * @param {number} angle
     */
    rotateZ(angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return new Vec3(this.x * cos - this.y * sin, this.x * sin + this.y * cos, this.z);
    }

    /**
     * Perspective projection onto a 2-D plane.
     * Returns a Vec2 in canvas-pixel space, centered at `center`.
     *
     * @param {{ x: number, y: number }} center  Pixel-space origin (e.g. { x: 500, y: 500 }).
     * @param {number} [fovDistance=600]          Camera-to-projection-plane distance.
     * @returns {Vec2}
     */
    project(center, fovDistance = 600) {
        const scale = fovDistance / (fovDistance + this.z);
        return new Vec2(center.x + this.x * scale, center.y + this.y * scale);
    }

    toString() { return `Vec3(${this.x.toFixed(4)}, ${this.y.toFixed(4)}, ${this.z.toFixed(4)})`; }

    static from(obj) { return new Vec3(obj.x, obj.y, obj.z ?? 0); }
    static get ZERO() { return new Vec3(0, 0, 0); }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  SHAPE GENERATORS
// Each function returns an array of Vec2 (normalized or pixel, depending on args).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sample points along a straight line using adaptive spacing.
 *
 * @param {{ x, y }}  p0
 * @param {{ x, y }}  p1
 * @param {number}   [spacing=0.01]    Step size (same units as coordinates).
 * @param {number}   [maxPoints=512]   Hard cap on returned points.
 * @returns {Vec2[]}
 */
function interpolate(p0, p1, spacing = 0.01, maxPoints = 512) {
    const a = Vec2.from(p0);
    const b = Vec2.from(p1);
    const dist = a.distanceTo(b);
    const steps = clamp(Math.floor(dist / spacing), 1, maxPoints);
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(a.lerp(b, i / steps));
    return pts;
}

/**
 * Quadratic Bézier curve (one control point).
 *
 * @param {{ x, y }} p0   Start point.
 * @param {{ x, y }} ctrl Control point.
 * @param {{ x, y }} p1   End point.
 * @param {number}  [steps=40]
 * @returns {Vec2[]}
 */
function quadraticCurve(p0, ctrl, p1, steps = 40) {
    const a = Vec2.from(p0), c = Vec2.from(ctrl), b = Vec2.from(p1);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t  = i / steps;
        const mt = 1 - t;
        pts.push(new Vec2(
            mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x,
            mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y,
        ));
    }
    return pts;
}

/**
 * Cubic Bézier curve (two control points).
 *
 * @param {{ x, y }} p0    Start.
 * @param {{ x, y }} ctrl1 First control point.
 * @param {{ x, y }} ctrl2 Second control point.
 * @param {{ x, y }} p1    End.
 * @param {number}  [steps=40]
 * @returns {Vec2[]}
 */
function cubicCurve(p0, ctrl1, ctrl2, p1, steps = 40) {
    const a = Vec2.from(p0), b = Vec2.from(ctrl1), c = Vec2.from(ctrl2), d = Vec2.from(p1);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t  = i / steps;
        const mt = 1 - t;
        const mt2 = mt * mt;
        const t2  = t * t;
        pts.push(new Vec2(
            mt2 * mt * a.x + 3 * mt2 * t * b.x + 3 * mt * t2 * c.x + t2 * t * d.x,
            mt2 * mt * a.y + 3 * mt2 * t * b.y + 3 * mt * t2 * c.y + t2 * t * d.y,
        ));
    }
    return pts;
}

/**
 * Catmull-Rom spline through a sequence of control points.
 * Produces smooth curves without manual control-point placement.
 *
 * @param {{ x, y }[]} pts   At least 4 points.
 * @param {number}    [steps=20]  Segments between each pair of inner points.
 * @returns {Vec2[]}
 */
function catmullRom(pts, steps = 20) {
    if (pts.length < 4) throw new Error('catmullRom needs at least 4 points');
    const v = pts.map(Vec2.from);
    const out = [];
    for (let i = 1; i < v.length - 2; i++) {
        const [p0, p1, p2, p3] = [v[i - 1], v[i], v[i + 1], v[i + 2]];
        for (let s = 0; s < steps; s++) {
            const t  = s / steps;
            const t2 = t * t;
            const t3 = t2 * t;
            out.push(new Vec2(
                0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
            ));
        }
    }
    out.push(v[v.length - 2]);
    return out;
}

/**
 * Circle.
 *
 * @param {{ x, y }} center
 * @param {number}   radius
 * @param {number}  [steps=64]
 * @returns {Vec2[]}
 */
function circlePoints(center, radius, steps = 64) {
    const c = Vec2.from(center);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        pts.push(new Vec2(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius));
    }
    return pts;
}

/**
 * Ellipse.
 *
 * @param {{ x, y }} center
 * @param {number}   rx      Radius on X axis.
 * @param {number}   ry      Radius on Y axis.
 * @param {number}  [rotation=0]  Rotation in radians.
 * @param {number}  [steps=64]
 * @returns {Vec2[]}
 */
function ellipsePoints(center, rx, ry, rotation = 0, steps = 64) {
    const c  = Vec2.from(center);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const a  = (i / steps) * Math.PI * 2;
        const lx = Math.cos(a) * rx;
        const ly = Math.sin(a) * ry;
        pts.push(new Vec2(c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos));
    }
    return pts;
}

/**
 * Circular arc.
 *
 * @param {{ x, y }} center
 * @param {number}   radius
 * @param {number}   startAngle  Start angle in radians.
 * @param {number}   endAngle    End angle in radians.
 * @param {number}  [steps=32]
 * @returns {Vec2[]}
 */
function arcPoints(center, radius, startAngle, endAngle, steps = 32) {
    const c = Vec2.from(center);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const a = lerp(startAngle, endAngle, i / steps);
        pts.push(new Vec2(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius));
    }
    return pts;
}

/**
 * Axis-aligned rectangle (outline).
 *
 * @param {{ x, y }} topLeft
 * @param {number}   width
 * @param {number}   height
 * @param {number}  [stepsPerSide=10]
 * @returns {Vec2[]}
 */
function rectPoints(topLeft, width, height, stepsPerSide = 10) {
    const { x, y } = topLeft;
    const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
        { x, y },
    ];
    const pts = [];
    for (let i = 0; i < 4; i++) {
        const seg = interpolate(corners[i], corners[i + 1], 1, stepsPerSide);
        // Avoid duplicate corner points except at the very end
        if (i > 0) seg.shift();
        pts.push(...seg);
    }
    return pts;
}

/**
 * Regular polygon.
 *
 * @param {{ x, y }} center
 * @param {number}   radius
 * @param {number}   sides       Number of sides (≥ 3).
 * @param {number}  [rotation=0] Rotation in radians.
 * @returns {Vec2[]}
 */
function polygonPoints(center, radius, sides, rotation = 0) {
    if (sides < 3) throw new Error('polygon needs at least 3 sides');
    const c = Vec2.from(center);
    const pts = [];
    for (let i = 0; i <= sides; i++) {
        const a = rotation + (i / sides) * Math.PI * 2;
        pts.push(new Vec2(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius));
    }
    return pts;
}

/**
 * Star / asterisk shape.
 *
 * @param {{ x, y }} center
 * @param {number}   outerRadius
 * @param {number}   innerRadius
 * @param {number}  [points=5]
 * @param {number}  [rotation=0]  Radians. Default points a tip upward.
 * @returns {Vec2[]}
 */
function starPoints(center, outerRadius, innerRadius, points = 5, rotation = -Math.PI / 2) {
    const c = Vec2.from(center);
    const total = points * 2;
    const verts = [];
    for (let i = 0; i <= total; i++) {
        const a = rotation + (i % total) * (Math.PI / points);
        const r = i % 2 === 0 ? outerRadius : innerRadius;
        verts.push(new Vec2(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
    }
    return verts;
}

/**
 * Spiral (Archimedean).
 *
 * @param {{ x, y }} center
 * @param {number}   startRadius
 * @param {number}   endRadius
 * @param {number}  [turns=3]
 * @param {number}  [steps=180]
 * @returns {Vec2[]}
 */
function spiralPoints(center, startRadius, endRadius, turns = 3, steps = 180) {
    const c = Vec2.from(center);
    const totalAngle = turns * Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = t * totalAngle;
        const r = lerp(startRadius, endRadius, t);
        pts.push(new Vec2(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
    }
    return pts;
}

/**
 * Lissajous curve.
 *
 * @param {{ x, y }} center
 * @param {number}   rx         Horizontal amplitude.
 * @param {number}   ry         Vertical amplitude.
 * @param {number}  [freqX=3]
 * @param {number}  [freqY=2]
 * @param {number}  [phase=Math.PI/2]
 * @param {number}  [steps=180]
 * @returns {Vec2[]}
 */
function lissajousPoints(center, rx, ry, freqX = 3, freqY = 2, phase = Math.PI / 2, steps = 180) {
    const c = Vec2.from(center);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        pts.push(new Vec2(c.x + Math.cos(freqX * t + phase) * rx, c.y + Math.sin(freqY * t) * ry));
    }
    return pts;
}

/**
 * Rose curve (rhodonea).
 *
 * @param {{ x, y }} center
 * @param {number}   radius
 * @param {number}  [k=3]       Petal count (odd k → k petals, even k → 2k petals).
 * @param {number}  [steps=360]
 * @returns {Vec2[]}
 */
function rosePoints(center, radius, k = 3, steps = 360) {
    const c = Vec2.from(center);
    const pts = [];
    const turns = (k % 2 === 0) ? 2 : 1;
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2 * turns;
        const r = radius * Math.cos(k * t);
        pts.push(new Vec2(c.x + r * Math.cos(t), c.y + r * Math.sin(t)));
    }
    return pts;
}

/**
 * Heart curve (parametric).
 *
 * @param {{ x, y }} center
 * @param {number}   size      Scale factor (pixels or normalized units).
 * @param {number}  [steps=120]
 * @returns {Vec2[]}
 */
function heartPoints(center, size, steps = 120) {
    const c = Vec2.from(center);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t  = (i / steps) * Math.PI * 2;
        const x  = 16 * Math.pow(Math.sin(t), 3);
        const y  = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        const s  = size / 17; // normalize heart to ~size units
        pts.push(new Vec2(c.x + x * s, c.y + y * s));
    }
    return pts;
}

/**
 * Rasterize a filled rectangle as a grid of scan-line points.
 * Useful for "filling" an area with dots when the canvas has no native fill.
 *
 * @param {{ x, y }} topLeft
 * @param {number}   width
 * @param {number}   height
 * @param {number}  [spacing=0.01]  Distance between scan lines (and between points on each line).
 * @returns {Vec2[]}
 */
function fillRect(topLeft, width, height, spacing = 0.01) {
    const pts = [];
    const rows = Math.floor(height / spacing);
    for (let row = 0; row <= rows; row++) {
        const y   = topLeft.y + row * spacing;
        const cols = Math.floor(width / spacing);
        for (let col = 0; col <= cols; col++) {
            pts.push(new Vec2(topLeft.x + col * spacing, y));
        }
    }
    return pts;
}

/**
 * Rasterize a filled circle (flood of dots arranged in scan-line order).
 *
 * @param {{ x, y }} center
 * @param {number}   radius
 * @param {number}  [spacing=0.01]
 * @returns {Vec2[]}
 */
function fillCircle(center, radius, spacing = 0.01) {
    const c = Vec2.from(center);
    const pts = [];
    for (let dy = -radius; dy <= radius; dy += spacing) {
        const halfW = Math.sqrt(Math.max(0, radius * radius - dy * dy));
        for (let dx = -halfW; dx <= halfW; dx += spacing) {
            pts.push(new Vec2(c.x + dx, c.y + dy));
        }
    }
    return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  COLOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Color utility namespace.
 * All conversions work with 6-digit hex strings (e.g. `'#ff00ff'`).
 */
const Color = {
    /** Random hex color. */
    randomHex() {
        return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    },

    /**
     * Parse `'#rrggbb'` → `{ r, g, b }` (0-255 integers).
     * @param {string} hex
     * @returns {{ r: number, g: number, b: number }}
     */
    hexToRgb(hex) {
        const n = parseInt(hex.replace('#', ''), 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    },

    /**
     * `{ r, g, b }` → `'#rrggbb'`.
     * @param {{ r: number, g: number, b: number }} rgb
     * @returns {string}
     */
    rgbToHex({ r, g, b }) {
        return '#' + [r, g, b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
    },

    /**
     * Linear interpolation between two hex colors.
     * @param {string} hexA
     * @param {string} hexB
     * @param {number} t    0..1
     * @returns {string}
     */
    lerp(hexA, hexB, t) {
        const a = Color.hexToRgb(hexA), b = Color.hexToRgb(hexB);
        return Color.rgbToHex({
            r: lerp(a.r, b.r, t),
            g: lerp(a.g, b.g, t),
            b: lerp(a.b, b.b, t),
        });
    },

    /**
     * HSL → `'#rrggbb'`.
     * @param {number} h  Hue 0..360.
     * @param {number} s  Saturation 0..100.
     * @param {number} l  Lightness 0..100.
     * @returns {string}
     */
    hslToHex(h, s, l) {
        l /= 100;
        const a = (s / 100) * Math.min(l, 1 - l);
        const f = n => {
            const k = (n + h / 30) % 12;
            return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    },

    /**
     * Rainbow hue sweep — maps `t` (0..1) to a full hue cycle.
     * @param {number} t     0..1
     * @param {number} [s=100]
     * @param {number} [l=50]
     * @returns {string}
     */
    rainbow(t, s = 100, l = 50) {
        return Color.hslToHex((t * 360) % 360, s, l);
    },

    /**
     * Slightly mutate the blue channel to force a new continuous path on the
     * receiver (Draw on my Face renders same-color consecutive points as one stroke).
     * @param {string}  hex
     * @param {boolean} toggle
     * @returns {string}
     */
    nudge(hex, toggle) {
        const rgb = Color.hexToRgb(hex);
        rgb.b = toggle ? (rgb.b ^ 1) : rgb.b;
        return Color.rgbToHex(rgb);
    },

    /**
     * Darken a hex color by a ratio.
     * @param {string} hex
     * @param {number} amount  0..1 (1 = black, 0 = no change)
     * @returns {string}
     */
    darken(hex, amount) {
        const rgb = Color.hexToRgb(hex);
        return Color.rgbToHex({ r: rgb.r * (1 - amount), g: rgb.g * (1 - amount), b: rgb.b * (1 - amount) });
    },

    /**
     * Lighten a hex color by a ratio.
     * @param {string} hex
     * @param {number} amount  0..1 (1 = white, 0 = no change)
     * @returns {string}
     */
    lighten(hex, amount) {
        const rgb = Color.hexToRgb(hex);
        return Color.rgbToHex({
            r: rgb.r + (255 - rgb.r) * amount,
            g: rgb.g + (255 - rgb.g) * amount,
            b: rgb.b + (255 - rgb.b) * amount,
        });
    },

    /**
     * Return a color with alpha=0 approximation — blends toward a background color.
     * Because the canvas only accepts opaque hex, this simulates transparency by
     * interpolating toward `bgHex`.
     * @param {string} hex
     * @param {number} alpha   0..1 (0 = fully transparent / bg, 1 = opaque)
     * @param {string} [bgHex='#000000']
     * @returns {string}
     */
    withAlpha(hex, alpha, bgHex = '#000000') {
        return Color.lerp(bgHex, hex, alpha);
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// §6  VECTOR FONT  (glyph definitions + renderer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stroke-based vector font.
 * Each glyph is an array of strokes; each stroke is an array of [x, y] pairs
 * in a 0..1 × 0..1 local coordinate space.
 */
const GLYPHS = {
    'A': [[[0.5,0],[0,1]],   [[0.5,0],[1,1]],   [[0.15,0.55],[0.85,0.55]]],
    'B': [[[0,0],[0,1]], [[0,0],[0.7,0],[0.9,0.2],[0.9,0.42],[0.7,0.52],[0,0.52]], [[0,0.52],[0.75,0.52],[0.92,0.68],[0.92,0.85],[0.75,1],[0,1]]],
    'C': [[[0.9,0.15],[0.65,0],[0.3,0],[0.08,0.22],[0,0.5],[0.08,0.78],[0.3,1],[0.65,1],[0.9,0.85]]],
    'D': [[[0,0],[0,1]], [[0,0],[0.55,0],[0.88,0.22],[1,0.5],[0.88,0.78],[0.55,1],[0,1]]],
    'E': [[[0,0],[1,0]], [[0,0],[0,1]], [[0,0.5],[0.82,0.5]], [[0,1],[1,1]]],
    'F': [[[0,0],[1,0]], [[0,0],[0,1]], [[0,0.5],[0.82,0.5]]],
    'G': [[[0.9,0.15],[0.65,0],[0.3,0],[0.08,0.22],[0,0.5],[0.08,0.78],[0.3,1],[0.65,1],[0.9,0.8],[0.9,0.5],[0.5,0.5]]],
    'H': [[[0,0],[0,1]], [[1,0],[1,1]], [[0,0.5],[1,0.5]]],
    'I': [[[0.2,0],[0.8,0]], [[0.5,0],[0.5,1]], [[0.2,1],[0.8,1]]],
    'J': [[[0.2,0],[0.8,0]], [[0.6,0],[0.6,0.8],[0.48,0.95],[0.28,1],[0.1,0.82]]],
    'K': [[[0,0],[0,1]], [[1,0],[0,0.52]], [[0,0.52],[1,1]]],
    'L': [[[0,0],[0,1]], [[0,1],[1,1]]],
    'M': [[[0,1],[0,0],[0.5,0.55],[1,0],[1,1]]],
    'N': [[[0,1],[0,0],[1,1],[1,0]]],
    'O': [[[0.5,0],[0.22,0],[0.05,0.28],[0,0.5],[0.05,0.72],[0.22,1],[0.5,1],[0.78,1],[0.95,0.72],[1,0.5],[0.95,0.28],[0.78,0],[0.5,0]]],
    'P': [[[0,0],[0,1]], [[0,0],[0.7,0],[0.92,0.18],[0.92,0.42],[0.7,0.55],[0,0.55]]],
    'Q': [[[0.5,0],[0.22,0],[0.05,0.28],[0,0.5],[0.05,0.72],[0.22,1],[0.5,1],[0.78,1],[0.95,0.72],[1,0.5],[0.95,0.28],[0.78,0],[0.5,0]], [[0.6,0.62],[1,1]]],
    'R': [[[0,0],[0,1]], [[0,0],[0.7,0],[0.92,0.18],[0.92,0.42],[0.7,0.55],[0,0.55]], [[0.42,0.55],[1,1]]],
    'S': [[[0.92,0.12],[0.7,0],[0.3,0],[0.08,0.22],[0.08,0.42],[0.3,0.52],[0.7,0.52],[0.92,0.68],[0.92,0.85],[0.7,1],[0.3,1],[0.08,0.88]]],
    'T': [[[0,0],[1,0]], [[0.5,0],[0.5,1]]],
    'U': [[[0,0],[0,0.75],[0.12,0.9],[0.3,1],[0.7,1],[0.88,0.9],[1,0.75],[1,0]]],
    'V': [[[0,0],[0.5,1],[1,0]]],
    'W': [[[0,0],[0.22,1],[0.5,0.45],[0.78,1],[1,0]]],
    'X': [[[0,0],[1,1]], [[1,0],[0,1]]],
    'Y': [[[0,0],[0.5,0.52],[1,0]], [[0.5,0.52],[0.5,1]]],
    'Z': [[[0,0],[1,0],[0,1],[1,1]]],
    'a': [[[0.85,0.3],[0.85,1]], [[0.85,0.52],[0.55,0.3],[0.22,0.3],[0.05,0.52],[0.05,0.78],[0.22,1],[0.55,1],[0.85,0.78]]],
    'b': [[[0,0],[0,1]], [[0,0.55],[0.3,0.3],[0.68,0.3],[0.92,0.52],[0.92,0.78],[0.68,1],[0.3,1],[0,0.78]]],
    'c': [[[0.88,0.38],[0.65,0.3],[0.35,0.3],[0.1,0.5],[0.1,0.78],[0.35,1],[0.65,1],[0.88,0.88]]],
    'd': [[[0.92,0],[0.92,1]], [[0.92,0.52],[0.62,0.3],[0.3,0.3],[0.08,0.52],[0.08,0.78],[0.3,1],[0.62,1],[0.92,0.78]]],
    'e': [[[0.08,0.62],[0.92,0.62],[0.92,0.42],[0.68,0.3],[0.32,0.3],[0.08,0.52],[0.08,0.78],[0.32,1],[0.65,1],[0.88,0.88]]],
    'f': [[[0.72,0.02],[0.42,0.02],[0.2,0.18],[0.2,1]], [[0.05,0.45],[0.72,0.45]]],
    'g': [[[0.92,0.3],[0.92,1.08],[0.72,1.22],[0.4,1.22],[0.18,1.08]], [[0.92,0.52],[0.62,0.3],[0.3,0.3],[0.08,0.52],[0.08,0.78],[0.3,1],[0.62,1],[0.92,0.78]]],
    'h': [[[0,0],[0,1]], [[0,0.58],[0.3,0.3],[0.65,0.3],[0.88,0.52],[0.88,1]]],
    'i': [[[0.5,0.12],[0.5,0.18]], [[0.5,0.32],[0.5,1]]],
    'j': [[[0.62,0.12],[0.62,0.18]], [[0.62,0.32],[0.62,0.9],[0.45,1.08],[0.22,1.02]]],
    'k': [[[0.1,0],[0.1,1]], [[0.82,0.3],[0.1,0.65]], [[0.1,0.65],[0.82,1]]],
    'l': [[[0.3,0],[0.52,0],[0.52,0.88],[0.68,1]]],
    'm': [[[0.05,0.3],[0.05,1]], [[0.05,0.55],[0.25,0.3],[0.5,0.3],[0.65,0.5],[0.65,1]], [[0.65,0.55],[0.8,0.3],[0.95,0.3],[1,0.5],[1,1]]],
    'n': [[[0.1,0.3],[0.1,1]], [[0.1,0.55],[0.35,0.3],[0.65,0.3],[0.88,0.52],[0.88,1]]],
    'o': [[[0.5,0.3],[0.22,0.3],[0.05,0.52],[0.05,0.78],[0.22,1],[0.5,1],[0.78,1],[0.95,0.78],[0.95,0.52],[0.78,0.3],[0.5,0.3]]],
    'p': [[[0.1,0.3],[0.1,1.22]], [[0.1,0.52],[0.35,0.3],[0.65,0.3],[0.88,0.52],[0.88,0.78],[0.65,1],[0.35,1],[0.1,0.78]]],
    'q': [[[0.92,0.3],[0.92,1.22]], [[0.92,0.52],[0.65,0.3],[0.35,0.3],[0.12,0.52],[0.12,0.78],[0.35,1],[0.65,1],[0.92,0.78]]],
    'r': [[[0.15,0.3],[0.15,1]], [[0.15,0.55],[0.38,0.35],[0.62,0.3],[0.82,0.35]]],
    's': [[[0.82,0.38],[0.6,0.3],[0.28,0.3],[0.12,0.48],[0.12,0.62],[0.35,0.68],[0.65,0.68],[0.88,0.8],[0.88,0.9],[0.65,1],[0.28,1],[0.12,0.9]]],
    't': [[[0.42,0.05],[0.42,0.9],[0.58,1]], [[0.08,0.38],[0.78,0.38]]],
    'u': [[[0.1,0.3],[0.1,0.78],[0.25,0.95],[0.5,1],[0.75,0.95],[0.9,0.78],[0.9,0.3]]],
    'v': [[[0.08,0.3],[0.5,1],[0.92,0.3]]],
    'w': [[[0.05,0.3],[0.25,1],[0.5,0.58],[0.75,1],[0.95,0.3]]],
    'x': [[[0.1,0.3],[0.9,1]], [[0.9,0.3],[0.1,1]]],
    'y': [[[0.1,0.3],[0.5,0.78]], [[0.9,0.3],[0.5,0.78],[0.3,1.08],[0.1,1.18]]],
    'z': [[[0.08,0.3],[0.92,0.3],[0.08,1],[0.92,1]]],
    '0': [[[0.5,0],[0.22,0],[0.05,0.25],[0,0.5],[0.05,0.75],[0.22,1],[0.5,1],[0.78,1],[0.95,0.75],[1,0.5],[0.95,0.25],[0.78,0],[0.5,0]], [[0.22,0.75],[0.78,0.25]]],
    '1': [[[0.22,0.18],[0.5,0],[0.5,1]]],
    '2': [[[0.08,0.22],[0.28,0.02],[0.72,0.02],[0.92,0.22],[0.92,0.42],[0.08,0.88],[0.08,1],[0.92,1]]],
    '3': [[[0.08,0.05],[0.92,0.05],[0.5,0.5],[0.9,0.62],[0.9,0.85],[0.7,1],[0.3,1],[0.1,0.88]]],
    '4': [[[0.72,0],[0.08,0.65],[0.95,0.65]], [[0.72,0],[0.72,1]]],
    '5': [[[0.92,0],[0.08,0],[0.08,0.45],[0.42,0.35],[0.82,0.38],[0.95,0.58],[0.95,0.82],[0.78,1],[0.38,1],[0.08,0.88]]],
    '6': [[[0.88,0.12],[0.65,0],[0.28,0],[0.08,0.28],[0.05,0.58],[0.05,0.78],[0.22,1],[0.55,1],[0.88,0.85],[0.88,0.6],[0.58,0.45],[0.05,0.55]]],
    '7': [[[0.08,0.02],[0.92,0.02],[0.35,1]]],
    '8': [[[0.5,0.5],[0.2,0.5],[0.05,0.32],[0.05,0.12],[0.2,0],[0.5,0],[0.8,0],[0.95,0.12],[0.95,0.32],[0.8,0.5],[0.5,0.5],[0.2,0.5],[0.05,0.65],[0.05,0.85],[0.2,1],[0.5,1],[0.8,1],[0.95,0.85],[0.95,0.65],[0.8,0.5]]],
    '9': [[[0.12,0.9],[0.35,1],[0.68,1],[0.92,0.8],[0.95,0.52],[0.95,0.22],[0.78,0.02],[0.5,0],[0.18,0.15],[0.05,0.45],[0.18,0.55],[0.5,0.55],[0.95,0.5]]],
    '!': [[[0.5,0],[0.5,0.65]], [[0.45,0.85],[0.45,1],[0.55,1],[0.55,0.85],[0.45,0.85]]],
    '?': [[[0.1,0.2],[0.3,0],[0.7,0],[0.9,0.2],[0.9,0.42],[0.5,0.6],[0.5,0.72]], [[0.45,0.88],[0.45,1],[0.55,1],[0.55,0.88],[0.45,0.88]]],
    '.': [[[0.38,0.85],[0.38,1],[0.62,1],[0.62,0.85],[0.38,0.85]]],
    ',': [[[0.38,0.8],[0.38,0.95],[0.62,0.95],[0.62,0.8],[0.38,0.8]], [[0.5,0.95],[0.32,1.18]]],
    ':': [[[0.38,0.3],[0.62,0.3],[0.62,0.45],[0.38,0.45],[0.38,0.3]], [[0.38,0.75],[0.62,0.75],[0.62,0.9],[0.38,0.9],[0.38,0.75]]],
    ';': [[[0.38,0.3],[0.62,0.3],[0.62,0.45],[0.38,0.45],[0.38,0.3]], [[0.38,0.8],[0.38,0.95],[0.62,0.95],[0.62,0.8],[0.38,0.8]], [[0.5,0.95],[0.32,1.18]]],
    '-': [[[0.08,0.5],[0.92,0.5]]],
    '_': [[[0,1],[1,1]]],
    '/': [[[1,0],[0,1]]],
    '\\': [[[0,0],[1,1]]],
    '(': [[[0.7,0],[0.3,0.25],[0.15,0.5],[0.3,0.75],[0.7,1]]],
    ')': [[[0.3,0],[0.7,0.25],[0.85,0.5],[0.7,0.75],[0.3,1]]],
    '[': [[[0.65,0],[0.3,0],[0.3,1],[0.65,1]]],
    ']': [[[0.35,0],[0.7,0],[0.7,1],[0.35,1]]],
    '+': [[[0.5,0.1],[0.5,0.9]], [[0.1,0.5],[0.9,0.5]]],
    '*': [[[0.5,0.1],[0.5,0.9]], [[0.1,0.3],[0.9,0.7]], [[0.9,0.3],[0.1,0.7]]],
    '#': [[[0.25,0],[0.15,1]], [[0.75,0],[0.65,1]], [[0.1,0.35],[0.9,0.35]], [[0.1,0.65],[0.9,0.65]]],
    '@': [[[0.65,0.52],[0.5,0.38],[0.35,0.4],[0.25,0.55],[0.28,0.72],[0.45,0.8],[0.62,0.75],[0.65,0.52],[0.68,0.25],[0.5,0.12],[0.25,0.12],[0.08,0.28],[0.05,0.52],[0.12,0.75],[0.35,0.9],[0.62,0.9],[0.85,0.75],[0.9,0.52]]],
    ' ': [],
};

/**
 * Compute the points for a single text stroke, scaled and translated.
 *
 * @param {number[][]} rawPts  Array of [x, y] pairs in glyph local space.
 * @param {number}     ox      X offset (pixels).
 * @param {number}     oy      Y offset (pixels).
 * @param {number}     scale   Font size (pixels).
 * @param {number}     strokeSteps  Interpolation steps per segment.
 * @returns {Vec2[]}  Pixel-space points.
 */
function _glyphStrokePoints(rawPts, ox, oy, scale, strokeSteps = 5) {
    const out = [];
    for (let i = 0; i < rawPts.length - 1; i++) {
        const [x0, y0] = rawPts[i];
        const [x1, y1] = rawPts[i + 1];
        for (let s = 0; s < strokeSteps; s++) {
            const t = s / strokeSteps;
            out.push(new Vec2(ox + (x0 + (x1 - x0) * t) * scale, oy + (y0 + (y1 - y0) * t) * scale));
        }
    }
    const last = rawPts[rawPts.length - 1];
    out.push(new Vec2(ox + last[0] * scale, oy + last[1] * scale));
    return out;
}

/**
 * Get all pixel-space points for a single character glyph.
 *
 * @param {string} ch           The character.
 * @param {number} ox           X origin (pixels).
 * @param {number} oy           Y origin (pixels).
 * @param {number} [size=42]    Font size (pixels).
 * @param {number} [steps=5]    Interpolation steps per stroke segment.
 * @returns {{ strokes: Vec2[][] }}  One array of points per stroke.
 */
function glyphStrokes(ch, ox, oy, size = 42, steps = 5) {
    const key = ch.toUpperCase();
    const def  = GLYPHS[key] ?? GLYPHS[' '];
    return {
        strokes: def.map(rawPts => _glyphStrokePoints(rawPts, ox, oy, size, steps)),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7  FRAME RATE CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple fixed-FPS frame limiter.
 *
 * Usage:
 *   const fps = new FrameRate(30);
 *   while (true) {
 *     drawFrame();
 *     await fps.wait();   // waits only the time remaining in the frame budget
 *   }
 */
class FrameRate {
    /**
     * @param {number} [targetFPS=30]
     */
    constructor(targetFPS = 30) {
        this.frameBudgetMs = 1000 / targetFPS;
        this._last = 0;
    }

    /** Wait for the remainder of the current frame's time budget. */
    async wait() {
        const now     = Date.now();
        const elapsed = now - this._last;
        const remaining = this.frameBudgetMs - elapsed;
        if (remaining > 0) await sleep(remaining);
        this._last = Date.now();
    }

    /** Reset the timer (call before the first frame). */
    reset() { this._last = Date.now(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// §8  PUBLISH QUEUE — concurrent worker pool with batching, retry, monitoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages a pool of concurrent publish workers with:
 *  - configurable concurrency
 *  - true auto-batching (multiple points per HTTP request)
 *  - exponential backoff retry with optional rate-limit detection
 *  - event callbacks: onRateLimit, onError, onFlush
 *  - live status metrics: pending, active, failed, sent counts
 */
class PublishQueue {
    /**
     * @param {object}   pubnub
     * @param {object}  [opts]
     * @param {number}  [opts.concurrency=8]     Max simultaneous in-flight publishes.
     * @param {number}  [opts.batchSize=1]       Points per publish call.
     * @param {number}  [opts.maxRetries=3]      Retry attempts before giving up a job.
     * @param {number}  [opts.retryBaseMs=200]   Base delay for exponential backoff.
     * @param {Function} [opts.onRateLimit]      Called with the rate-limit error when a 429 is detected.
     * @param {Function} [opts.onError]          Called with (error, jobs) for unrecoverable failures.
     * @param {Function} [opts.onFlush]          Called each time the queue drains to empty.
     */
    constructor(pubnub, {
        concurrency  = 8,
        batchSize    = 1,
        maxRetries   = 3,
        retryBaseMs  = 200,
        onRateLimit  = null,
        onError      = null,
        onFlush      = null,
    } = {}) {
        this.pubnub       = pubnub;
        this.concurrency  = concurrency;
        this.batchSize    = Math.max(1, batchSize);
        this.maxRetries   = maxRetries;
        this.retryBaseMs  = retryBaseMs;
        this.onRateLimit  = onRateLimit;
        this.onError      = onError;
        this.onFlush      = onFlush;

        this._queue       = [];
        this._active      = 0;
        this._aborted     = false;
        this._idleWaiters = [];

        // Metrics
        this.stats = { pending: 0, active: 0, sent: 0, failed: 0 };
    }

    /**
     * Enqueue a single publish job.
     * @param {string} channel
     * @param {object} message
     * @returns {Promise<void>}  Resolves when published; rejects on unrecoverable error.
     */
    push(channel, message) {
        return new Promise((resolve, reject) => {
            if (this._aborted) { reject(new Error('queue aborted')); return; }
            this._queue.push({ channel, message, resolve, reject });
            this.stats.pending++;
            this._drain();
        });
    }

    /**
     * Enqueue multiple messages at once (bypasses individual push overhead).
     * @param {string}   channel
     * @param {object[]} messages
     * @returns {Promise<void>[]}
     */
    pushBatch(channel, messages) {
        return messages.map(msg => this.push(channel, msg));
    }

    /** Abort all pending jobs and reject their promises. */
    abort() {
        this._aborted = true;
        const pending = this._queue.splice(0);
        this.stats.pending = 0;
        for (const job of pending) job.reject(new Error('queue aborted'));
        this._checkIdle();
    }

    /** Reset aborted state so the queue can accept new jobs. */
    reset() {
        this._aborted = false;
        this.stats = { pending: 0, active: 0, sent: 0, failed: 0 };
    }

    /**
     * Wait until the queue is fully drained (all pending + in-flight jobs done).
     * @returns {Promise<void>}
     */
    flush() {
        if (this._active === 0 && this._queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this._idleWaiters.push(resolve));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    async _publishWithRetry(jobs) {
        const channel = jobs[0].channel;
        let attempt   = 0;

        for (;;) {
            try {
                const isBatch = jobs.length > 1 && typeof this.pubnub.publishBatch === 'function';
                if (isBatch) {
                    await this.pubnub.publishBatch({ channel, messages: jobs.map(j => j.message) });
                } else if (jobs.length > 1) {
                    await Promise.all(jobs.map(j => this.pubnub.publish({ channel: j.channel, message: j.message })));
                } else {
                    await this.pubnub.publish({ channel, message: jobs[0].message });
                }

                this.stats.sent += jobs.length;
                for (const j of jobs) j.resolve();
                return;

            } catch (err) {
                attempt++;

                // Detect rate limiting (HTTP 429)
                const isRateLimit = err?.status === 429 || String(err?.message).includes('429');
                if (isRateLimit && this.onRateLimit) this.onRateLimit(err);

                if (attempt > this.maxRetries) {
                    this.stats.failed += jobs.length;
                    if (this.onError) this.onError(err, jobs);
                    for (const j of jobs) j.reject(err);
                    return;
                }

                // Exponential backoff — extra penalty on rate limit
                const delay = this.retryBaseMs * 2 ** (attempt - 1) * (isRateLimit ? 3 : 1);
                await sleep(delay);
            }
        }
    }

    _drain() {
        while (!this._aborted && this._active < this.concurrency && this._queue.length > 0) {
            const batch = this._queue.splice(0, this.batchSize);
            this.stats.pending -= batch.length;
            this._active++;
            this.stats.active = this._active;

            this._publishWithRetry(batch).finally(() => {
                this._active--;
                this.stats.active = this._active;
                this._drain();
                this._checkIdle();
            });
        }
    }

    _checkIdle() {
        if (this._active === 0 && this._queue.length === 0) {
            if (this.onFlush) this.onFlush(this.stats);
            const waiters = this._idleWaiters.splice(0);
            for (const resolve of waiters) resolve();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// §9  ARTIST — the main drawing bot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish-only bot that draws shapes on the PubNub canvas.
 *
 * Key concepts:
 *  - Coordinates are either **normalized** (0..1) or **pixel** (based on `resolution`).
 *    Pass `pixels: true` in draw options to use pixel coordinates.
 *  - Each userId on the receiver is treated as one continuous path.
 *    Set `uniqueUserIdPerPath: true` to auto-increment the userId per `drawPath` call,
 *    so each stroke is isolated (its own 40-point budget + independent expiry).
 *  - `drawText()` renders a string using the built-in vector font.
 */
class Artist {
    /**
     * @param {object}  [opts]
     * @param {string}  [opts.userId]               Base userId (default: random).
     * @param {string}  [opts.style='#ff00ff']       Default hex color.
     * @param {string}  [opts.channel='coords']      PubNub channel name.
     * @param {{ width, height }} [opts.resolution]  Virtual canvas size for pixel→norm conversion.
     * @param {string}  [opts.subscribeKey='demo']
     * @param {string}  [opts.publishKey='demo']
     * @param {string}  [opts.origin]
     * @param {string}  [opts.authKey]
     * @param {number}  [opts.concurrency=8]         PublishQueue worker count.
     * @param {number}  [opts.batchSize=1]           Points per publish call.
     * @param {number}  [opts.pointDelayMs=0]        Optional per-point delay (ms).
     * @param {boolean} [opts.uniqueUserIdPerPath]   Auto-increment userId per drawPath.
     * @param {Function} [opts.onRateLimit]          Rate-limit callback.
     * @param {Function} [opts.onError]              Error callback.
     * @param {Function} [opts.onFlush]              Queue-drain callback.
     */
    constructor({
        userId              = `bot-${Math.random().toString(36).slice(2)}`,
        style               = '#ff00ff',
        channel             = 'coords',
        resolution          = { width: 1000, height: 1000 },
        subscribeKey        = 'demo',
        publishKey          = 'demo',
        origin              = 'h2.pubnubapi.com',
        authKey             = 'user-default',
        concurrency         = 8,
        batchSize           = 1,
        pointDelayMs        = 0,
        uniqueUserIdPerPath = false,
        onRateLimit         = null,
        onError             = null,
        onFlush             = null,
    } = {}) {
        this.userId              = userId;
        this._baseUserId         = userId;
        this._pathCounter        = 0;
        this.uniqueUserIdPerPath = uniqueUserIdPerPath;
        this.style               = style;
        this.channel             = channel;
        this.resolution          = resolution;
        this.pointDelayMs        = pointDelayMs;
        this.pubnub              = PubNub({ userId, subscribeKey, publishKey, origin, authKey });
        this._seq                = 0;
        this._strokeToggle       = false;
        this._queue              = new PublishQueue(this.pubnub, {
            concurrency,
            batchSize,
            onRateLimit,
            onError,
            onFlush,
        });
    }

    // ── Configuration ─────────────────────────────────────────────────────────

    /**
     * Set the current draw color. Chainable.
     * @param {string} hex
     * @returns {this}
     */
    setStyle(hex) { this.style = hex; return this; }

    /**
     * Override userId. Resets the sequence counter. Chainable.
     * @param {string} id
     * @returns {this}
     */
    setUserId(id) { this.userId = id; this._seq = 0; return this; }

    /**
     * Advance to the next auto-incremented userId (`base-1`, `base-2`, …).
     * Useful for manually isolating a stroke when `uniqueUserIdPerPath` is false.
     * @returns {string}  The new userId.
     */
    nextUserId() {
        this._pathCounter++;
        this.userId = `${this._baseUserId}-${this._pathCounter}`;
        this._seq   = 0;
        return this.userId;
    }

    /** Live queue stats: `{ pending, active, sent, failed }`. */
    get stats() { return this._queue.stats; }

    // ── Low-level send ────────────────────────────────────────────────────────

    /**
     * Convert pixel coordinates to normalized (0..1) space.
     * @param {{ x, y }} pt
     * @returns {{ x, y }}
     */
    toNormalized({ x, y }) {
        return { x: x / this.resolution.width, y: y / this.resolution.height };
    }

    /**
     * Send a single point to the queue.
     *
     * @param {{ x, y }} coords   Normalized (default) or pixel if `pixels: true`.
     * @param {object}  [opts]
     * @param {boolean} [opts.pixels=false]
     * @param {string}  [opts.style]     Override color for this point only.
     * @returns {Promise<void>}
     */
    send(coords, { pixels = false, style } = {}) {
        const pt = pixels ? this.toNormalized(coords) : coords;
        this._seq++;
        return this._queue.push(this.channel, {
            userId: this.userId,
            style:  style ?? this.style,
            x:      pt.x,
            y:      pt.y,
            seq:    this._seq,
        });
    }

    // ── Path drawing ──────────────────────────────────────────────────────────

    /**
     * Draw a sequence of pre-computed points.
     *
     * @param {Vec2[] | { x, y }[]} points
     * @param {object}  [opts]
     * @param {boolean} [opts.pixels=false]         Points are in pixel space.
     * @param {number}  [opts.delayMs]              Per-point delay override.
     * @param {boolean} [opts.uniqueUserId]         Force a new userId for this path.
     * @param {string}  [opts.style]                Color override for this path.
     * @returns {Promise<void>}
     */
    async drawPath(points, { pixels = false, delayMs, uniqueUserId, style } = {}) {
        const useUnique = uniqueUserId ?? this.uniqueUserIdPerPath;
        if (useUnique) this.nextUserId();

        this._strokeToggle = !this._strokeToggle;
        const drawStyle = style ?? Color.nudge(this.style, this._strokeToggle);
        const delay     = delayMs ?? this.pointDelayMs;

        for (const p of points) {
            this.send(p, { pixels, style: drawStyle });
            if (delay > 0) await sleep(delay);
        }

        await this._queue.flush();
    }

    /** Abort all pending work. */
    abort() { this._queue.abort(); }

    // ── Shape drawing API ─────────────────────────────────────────────────────

    /**
     * Draw a straight line from `p0` to `p1`.
     *
     * @param {{ x, y }} p0
     * @param {{ x, y }} p1
     * @param {object}  [opts]
     * @param {boolean} [opts.pixels=false]
     * @param {number}  [opts.spacing=0.01]  Point density (same units as coords).
     * @param {number}  [opts.maxPoints=512]
     * @returns {Promise<void>}
     */
    async drawLine(p0, p1, opts = {}) {
        const defaultSpacing = opts.pixels ? 8 : 0.01;
        const pts = interpolate(p0, p1, opts.spacing ?? defaultSpacing, opts.maxPoints);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a quadratic Bézier curve (1 control point).
     *
     * @param {{ x, y }} p0
     * @param {{ x, y }} ctrl
     * @param {{ x, y }} p1
     * @param {object}  [opts]
     * @param {number}  [opts.steps=40]
     * @returns {Promise<void>}
     */
    async drawCurve(p0, ctrl, p1, opts = {}) {
        const pts = quadraticCurve(p0, ctrl, p1, opts.steps ?? 40);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a cubic Bézier curve (2 control points).
     *
     * @param {{ x, y }} p0
     * @param {{ x, y }} ctrl1
     * @param {{ x, y }} ctrl2
     * @param {{ x, y }} p1
     * @param {object}  [opts]
     * @param {number}  [opts.steps=40]
     * @returns {Promise<void>}
     */
    async drawCubicCurve(p0, ctrl1, ctrl2, p1, opts = {}) {
        const pts = cubicCurve(p0, ctrl1, ctrl2, p1, opts.steps ?? 40);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a smooth Catmull-Rom spline through the given waypoints.
     *
     * @param {{ x, y }[]} waypoints  At least 4 points.
     * @param {object}  [opts]
     * @param {number}  [opts.steps=20]  Segments between each inner point pair.
     * @returns {Promise<void>}
     */
    async drawSpline(waypoints, opts = {}) {
        const pts = catmullRom(waypoints, opts.steps ?? 20);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a circle.
     *
     * @param {{ x, y }} center
     * @param {number}   radius
     * @param {object}  [opts]
     * @param {number}  [opts.steps=64]
     * @returns {Promise<void>}
     */
    async drawCircle(center, radius, opts = {}) {
        const pts = circlePoints(center, radius, opts.steps ?? 64);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw an ellipse.
     *
     * @param {{ x, y }} center
     * @param {number}   rx        Horizontal radius.
     * @param {number}   ry        Vertical radius.
     * @param {object}  [opts]
     * @param {number}  [opts.rotation=0]  Radians.
     * @param {number}  [opts.steps=64]
     * @returns {Promise<void>}
     */
    async drawEllipse(center, rx, ry, opts = {}) {
        const pts = ellipsePoints(center, rx, ry, opts.rotation ?? 0, opts.steps ?? 64);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a circular arc.
     *
     * @param {{ x, y }} center
     * @param {number}   radius
     * @param {number}   startAngle  Radians.
     * @param {number}   endAngle    Radians.
     * @param {object}  [opts]
     * @param {number}  [opts.steps=32]
     * @returns {Promise<void>}
     */
    async drawArc(center, radius, startAngle, endAngle, opts = {}) {
        const pts = arcPoints(center, radius, startAngle, endAngle, opts.steps ?? 32);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw an axis-aligned rectangle.
     *
     * @param {{ x, y }} topLeft
     * @param {number}   width
     * @param {number}   height
     * @param {object}  [opts]
     * @param {number}  [opts.stepsPerSide=10]
     * @returns {Promise<void>}
     */
    async drawRect(topLeft, width, height, opts = {}) {
        const pts = rectPoints(topLeft, width, height, opts.stepsPerSide ?? 10);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a regular polygon.
     *
     * @param {{ x, y }} center
     * @param {number}   radius
     * @param {number}   sides
     * @param {object}  [opts]
     * @param {number}  [opts.rotation=0]  Radians.
     * @returns {Promise<void>}
     */
    async drawPolygon(center, radius, sides, opts = {}) {
        const pts = polygonPoints(center, radius, sides, opts.rotation ?? 0);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a star.
     *
     * @param {{ x, y }} center
     * @param {number}   outerRadius
     * @param {number}   innerRadius
     * @param {object}  [opts]
     * @param {number}  [opts.points=5]
     * @param {number}  [opts.rotation]  Radians (default: tip-up).
     * @returns {Promise<void>}
     */
    async drawStar(center, outerRadius, innerRadius, opts = {}) {
        const pts = starPoints(center, outerRadius, innerRadius, opts.points ?? 5, opts.rotation ?? -Math.PI / 2);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw an Archimedean spiral.
     *
     * @param {{ x, y }} center
     * @param {number}   startRadius
     * @param {number}   endRadius
     * @param {object}  [opts]
     * @param {number}  [opts.turns=3]
     * @param {number}  [opts.steps=180]
     * @returns {Promise<void>}
     */
    async drawSpiral(center, startRadius, endRadius, opts = {}) {
        const pts = spiralPoints(center, startRadius, endRadius, opts.turns ?? 3, opts.steps ?? 180);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a Lissajous figure.
     *
     * @param {{ x, y }} center
     * @param {number}   rx   Horizontal amplitude.
     * @param {number}   ry   Vertical amplitude.
     * @param {object}  [opts]
     * @param {number}  [opts.freqX=3]
     * @param {number}  [opts.freqY=2]
     * @param {number}  [opts.phase=Math.PI/2]
     * @param {number}  [opts.steps=180]
     * @returns {Promise<void>}
     */
    async drawLissajous(center, rx, ry, opts = {}) {
        const pts = lissajousPoints(center, rx, ry, opts.freqX ?? 3, opts.freqY ?? 2, opts.phase ?? Math.PI / 2, opts.steps ?? 180);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a rose curve (rhodonea).
     *
     * @param {{ x, y }} center
     * @param {number}   radius
     * @param {object}  [opts]
     * @param {number}  [opts.k=3]       Petal factor.
     * @param {number}  [opts.steps=360]
     * @returns {Promise<void>}
     */
    async drawRose(center, radius, opts = {}) {
        const pts = rosePoints(center, radius, opts.k ?? 3, opts.steps ?? 360);
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a heart.
     *
     * @param {{ x, y }} center
     * @param {number}   size
     * @param {object}  [opts]
     * @param {number}  [opts.steps=120]
     * @returns {Promise<void>}
     */
    async drawHeart(center, size, opts = {}) {
        const pts = heartPoints(center, size, opts.steps ?? 120);
        await this.drawPath(pts, opts);
    }

    /**
     * Fill a rectangle with scan-line dots.
     *
     * @param {{ x, y }} topLeft
     * @param {number}   width
     * @param {number}   height
     * @param {object}  [opts]
     * @param {number}  [opts.spacing=0.01]
     * @returns {Promise<void>}
     */
    async fillRect(topLeft, width, height, opts = {}) {
        const pts = fillRect(topLeft, width, height, opts.spacing ?? (opts.pixels ? 8 : 0.01));
        await this.drawPath(pts, opts);
    }

    /**
     * Fill a circle with scan-line dots.
     *
     * @param {{ x, y }} center
     * @param {number}   radius
     * @param {object}  [opts]
     * @param {number}  [opts.spacing=0.01]
     * @returns {Promise<void>}
     */
    async fillCircle(center, radius, opts = {}) {
        const pts = fillCircle(center, radius, opts.spacing ?? (opts.pixels ? 8 : 0.01));
        await this.drawPath(pts, opts);
    }

    /**
     * Draw a text string using the built-in vector font.
     * Long strings are word-wrapped automatically.
     *
     * @param {string}   text
     * @param {object}  [opts]
     * @param {number}  [opts.x=28]          Left margin (pixels).
     * @param {number}  [opts.y=36]          Top margin (pixels).
     * @param {number}  [opts.fontSize=42]   Font size (pixels).
     * @param {number}  [opts.lineHeight]    Line height (defaults to fontSize * 1.38).
     * @param {number}  [opts.charWidth]     Character advance (defaults to fontSize * 1.14).
     * @param {number}  [opts.strokeSteps=5] Interpolation steps per glyph stroke segment.
     * @param {number}  [opts.canvasWidth]   Wrap boundary (defaults to resolution.width).
     * @param {number}  [opts.canvasHeight]  Vertical boundary (defaults to resolution.height).
     * @param {string}  [opts.style]         Color override.
     * @returns {Promise<void>}
     */
    async drawText(text, {
        x           = 28,
        y           = 36,
        fontSize    = 42,
        lineHeight,
        charWidth,
        strokeSteps = 5,
        canvasWidth,
        canvasHeight,
        ...pathOpts
    } = {}) {
        const cw  = canvasWidth  ?? this.resolution.width;
        const ch  = canvasHeight ?? this.resolution.height;
        const lh  = lineHeight   ?? fontSize * 1.38;
        const adv = charWidth    ?? fontSize * 1.14;
        const marginX = x;
        const marginY = y;
        const maxX = cw - marginX;

        // Word wrap
        const words = text.split(' ');
        const lines = [];
        let current = '';
        for (const word of words) {
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length * adv > maxX && current) {
                lines.push(current);
                current = word;
            } else {
                current = candidate;
            }
        }
        if (current) lines.push(current);

        let cy = marginY;
        for (const line of lines) {
            if (cy + fontSize > ch - marginY) cy = marginY; // wrap to top
            let cx = marginX;
            for (const ch of line) {
                const { strokes } = glyphStrokes(ch, cx, cy, fontSize, strokeSteps);
                for (const stroke of strokes) {
                    if (stroke.length > 0) {
                        await this.drawPath(stroke, { pixels: true, ...pathOpts });
                    }
                }
                cx += adv;
            }
            cy += lh;
        }
    }

    /**
     * Draw a 3-D wireframe mesh defined by vertices and edges.
     * Handles projection, rotation, and edge drawing in one call.
     *
     * @param {Vec3[]}      vertices    Array of 3-D points.
     * @param {[number, number][]} edges  Pairs of vertex indices.
     * @param {{ x, y }}    center      2-D center for projection (pixels).
     * @param {object}     [opts]
     * @param {number}     [opts.fov=600]       Field-of-view distance.
     * @param {number}     [opts.spacing=25]    Line density (pixels).
     * @returns {Promise<void>}
     */
    async drawWireframe(vertices, edges, center, opts = {}) {
        const fov     = opts.fov ?? 600;
        const spacing = opts.spacing ?? 25;
        const proj    = vertices.map(v => v.project(center, fov));
        for (const [i, j] of edges) {
            await this.drawLine(proj[i], proj[j], { pixels: true, spacing, ...opts });
        }
    }

    /**
     * "Clear" the canvas by flooding it with the background color.
     * Because the canvas is an event stream with no erase primitive,
     * this draws over existing content with a dense grid of `bgColor` points.
     *
     * @param {object}  [opts]
     * @param {string}  [opts.bgColor='#000000']
     * @param {number}  [opts.spacing]   Dot spacing (default: 20 pixels if resolution-based).
     * @returns {Promise<void>}
     */
    async clearCanvas({ bgColor = '#000000', spacing } = {}) {
        const sp = spacing ?? 20;
        const w  = this.resolution.width;
        const h  = this.resolution.height;
        const pts = fillRect({ x: 0, y: 0 }, w, h, sp);
        const savedStyle = this.style;
        this.style = bgColor;
        await this.drawPath(pts, { pixels: true });
        this.style = savedStyle;
    }

    /**
     * "Fade" by drawing a semi-transparent overlay of `bgColor` dots.
     * Less aggressive than clearCanvas — lets old content bleed through.
     *
     * @param {object}  [opts]
     * @param {string}  [opts.bgColor='#000000']
     * @param {number}  [opts.passes=1]   Number of overlay passes (more = stronger fade).
     * @param {number}  [opts.spacing=40] Sparser than clearCanvas for partial coverage.
     * @returns {Promise<void>}
     */
    async fadeCanvas({ bgColor = '#000000', passes = 1, spacing =0 } = {}) {
        for (let p = 0; p < passes; p++) {
            await this.clearCanvas({ bgColor, spacing });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
module.exports = {
    // Primitives
    Vec2, Vec3,
    Color,
    FrameRate,

    // Shape generators (return Vec2[])
    cubicCurve,
    catmullRom,
    circlePoints,
    ellipsePoints,
    arcPoints,
    rectPoints,
    polygonPoints,
    starPoints,
    spiralPoints,
    lissajousPoints,
    rosePoints,
    heartPoints,
    fillRect,
    fillCircle,

    // Font
    GLYPHS,
    glyphStrokes,

    // Core
    PublishQueue,
    Artist,

    // Utils
    clamp, rand, sleep, lerp, toRad, toDeg,
};

