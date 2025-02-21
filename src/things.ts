import config from './config';
import scope from './scope';
import { drawArc, drawLine, drawPoint, drawText, flickeryWhite } from './canvas';
import { PointInstanceConstraint } from './constraints';
import { Drawing } from './Drawing';
import { List, Var } from './state';
import {
  Position,
  pointDist,
  pointDistToLineSegment,
  rotateAround,
  scaleAround,
  translate,
  origin,
  boundingBox,
} from './helpers';

type Transform = (pos: Position) => Position;

export interface Thing {
  get x(): number;
  get y(): number;
  contains(pos: Position): boolean;
  distanceTo(pos: Position): number;
  moveBy(dx: number, dy: number): void;
  render(transform: Transform, color?: string, depth?: number): void;
  forEachHandle(fn: (h: Handle) => void): void;
  replaceHandle(oldHandle: Handle, newHandle: Handle): void;
  forEachVar(fn: (v: Var<number>) => void): void;
}

export class Handle implements Thing {
  private static nextId = 0;

  readonly id = Handle.nextId++;
  readonly xVar: Var<number>;
  readonly yVar: Var<number>;

  constructor({ x, y }: Position) {
    this.xVar = new Var(x);
    this.yVar = new Var(y);
  }

  get x() {
    return this.xVar.value;
  }

  set x(newX: number) {
    this.xVar.value = newX;
  }

  get y() {
    return this.yVar.value;
  }

  set y(newY: number) {
    this.yVar.value = newY;
  }

  contains(pos: Position) {
    return pointDist(pos, this) <= config().closeEnough / scope.scale;
  }

  distanceTo(pos: Position) {
    return pointDist(this, pos);
  }

  moveBy(dx: number, dy: number) {
    this.xVar.value += dx;
    this.yVar.value += dy;
  }

  render(transform: Transform, color: string = config().instanceSideAttacherColor): void {
    if (config().debug) {
      drawText(transform(this), `(${this.x.toFixed(0)},${this.y.toFixed(0)})`);
    }
    drawPoint(this, color, transform);
  }

  forEachHandle(fn: (h: Handle) => void) {
    fn(this);
  }

  replaceHandle(oldHandle: Handle, newHandle: Handle) {
    throw new Error('should never call replace() on Handle');
  }

  forEachVar(fn: (v: Var<number>) => void) {
    fn(this.xVar);
    fn(this.yVar);
  }

  toString() {
    return `handle(id=${this.id})`;
  }
}

export class Line implements Thing {
  a: Handle;
  b: Handle;

  constructor(
    aPos: Position,
    bPos: Position,
    readonly isGuide: boolean,
  ) {
    this.a = new Handle(aPos);
    this.b = new Handle(bPos);
  }

  get x() {
    return (this.a.x + this.b.x) / 2;
  }

  get y() {
    return (this.a.y + this.b.y) / 2;
  }

  contains(pos: Position) {
    return (
      !this.a.contains(pos) &&
      !this.b.contains(pos) &&
      this.distanceTo(pos) <= config().closeEnough / scope.scale
    );
  }

  distanceTo(pos: Position) {
    return pointDistToLineSegment(pos, this.a, this.b);
  }

  moveBy(dx: number, dy: number) {
    this.forEachHandle((h) => h.moveBy(dx, dy));
  }

  render(transform: Transform, color?: string) {
    if (this.isGuide && !config().showGuideLines) {
      return;
    }
    const style = this.isGuide ? config().guideLineColor : (color ?? flickeryWhite());
    drawLine(this.a, this.b, style, transform);
  }

  forEachHandle(fn: (h: Handle) => void): void {
    fn(this.a);
    fn(this.b);
  }

  replaceHandle(oldHandle: Handle, newHandle: Handle) {
    if (this.a == oldHandle) {
      this.a = newHandle;
    }
    if (this.b == oldHandle) {
      this.b = newHandle;
    }
  }

  forEachVar(fn: (v: Var<number>) => void): void {
    this.forEachHandle((h) => h.forEachVar(fn));
  }
}

export class Arc implements Thing {
  a: Handle;
  b: Handle;
  c: Handle;
  readonly cummRotation: Var<number>; // TODO: update this while moving handles

  constructor(aPos: Position, bPos: Position, cPos: Position, cummRotation: number) {
    this.a = new Handle(aPos);
    this.b = pointDist(aPos, bPos) === 0 ? this.a : new Handle(bPos);
    this.c = new Handle(cPos);
    this.cummRotation = new Var(cummRotation);
  }

  get x() {
    return this.c.x;
  }

  get y() {
    return this.c.y;
  }

  contains(pos: Position) {
    // TODO: only return `true` if p is between a and b (angle-wise)
    return this.distanceTo(pos) <= config().closeEnough / scope.scale;
  }

  distanceTo(pos: Position) {
    return Math.abs(pointDist(pos, this.c) - pointDist(this.a, this.c));
  }

  moveBy(dx: number, dy: number) {
    this.forEachHandle((h) => h.moveBy(dx, dy));
  }

  render(transform: Transform, color?: string, depth = 0) {
    drawArc(this.c, this.a, this.b, this.cummRotation.value, color ?? flickeryWhite(), transform);
    if (depth === 1 && config().showControlPoints) {
      drawPoint(this.a, config().controlPointColor, transform);
      drawPoint(this.b, config().controlPointColor, transform);
      drawPoint(this.c, config().controlPointColor, transform);
    }
  }

  forEachHandle(fn: (h: Handle) => void): void {
    fn(this.a);
    if (this.a !== this.b) {
      fn(this.b);
    }
    fn(this.c);
  }

  replaceHandle(oldHandle: Handle, newHandle: Handle) {
    if (this.a == oldHandle) {
      this.a = newHandle;
    }
    if (this.b == oldHandle) {
      this.b = newHandle;
    }
    if (this.c == oldHandle) {
      this.c = newHandle;
    }
  }

  forEachVar(fn: (v: Var<number>) => void): void {
    this.forEachHandle((h) => h.forEachVar(fn));
  }
}

export class Instance implements Thing {
  private static nextId = 0;

  readonly transform = (p: Position) =>
    translate(scaleAround(rotateAround(p, origin, this.angle), origin, this.scale), this);

  readonly id = Instance.nextId++;
  readonly xVar: Var<number>;
  readonly yVar: Var<number>;
  readonly angleAndSizeVecX: Var<number>;
  readonly angleAndSizeVecY: Var<number>;
  readonly _attachers = new Var(new List<Handle>());

  get attachers() {
    return this._attachers.value;
  }

  set attachers(newAttachers: List<Handle>) {
    this._attachers.value = newAttachers;
  }

  constructor(
    readonly master: Drawing,
    x: number,
    y: number,
    size: number,
    angle: number,
    parent: Drawing,
  ) {
    this.xVar = new Var(x);
    this.yVar = new Var(y);
    this.angleAndSizeVecX = new Var(size * Math.cos(angle));
    this.angleAndSizeVecY = new Var(size * Math.sin(angle));
    this.addAttachers(master, parent);
  }

  private addAttachers(master: Drawing, parent: Drawing) {
    master.attachers.forEach((masterSideAttacher) => this.addAttacher(masterSideAttacher, parent));
  }

  addAttacher(masterSideAttacher: Handle, parent: Drawing) {
    const attacher = new Handle(this.transform(masterSideAttacher));
    this.attachers.unshift(attacher);
    parent.constraints.add(new PointInstanceConstraint(attacher, this, masterSideAttacher));
  }

  get x() {
    return this.xVar.value;
  }

  set x(x: number) {
    this.xVar.value = x;
  }

  get y() {
    return this.yVar.value;
  }

  set y(y: number) {
    this.yVar.value = y;
  }

  get size() {
    return Math.sqrt(
      Math.pow(this.angleAndSizeVecX.value, 2) + Math.pow(this.angleAndSizeVecY.value, 2),
    );
  }

  set size(newSize: number) {
    const angle = this.angle;
    this.angleAndSizeVecX.value = newSize * Math.cos(angle);
    this.angleAndSizeVecY.value = newSize * Math.sin(angle);
  }

  get angle() {
    return Math.atan2(this.angleAndSizeVecY.value, this.angleAndSizeVecX.value);
  }

  set angle(newAngle: number) {
    const size = this.size;
    this.angleAndSizeVecX.value = size * Math.cos(newAngle);
    this.angleAndSizeVecY.value = size * Math.sin(newAngle);
  }

  get scale() {
    return this.size / this.master.size;
  }

  set scale(newScale: number) {
    this.size = newScale * this.master.size;
  }

  contains(pos: Position): boolean {
    const { topLeft: ttl, bottomRight: tbr } = this.boundingBox();
    const ans = ttl.x <= pos.x && pos.x <= tbr.x && tbr.y <= pos.y && pos.y <= ttl.y;
    return ans;
  }

  boundingBox(stopAt = this.master) {
    const { topLeft, bottomRight } = this.master.boundingBox(stopAt);
    const ps = [
      topLeft,
      bottomRight,
      { x: topLeft.x, y: bottomRight.y },
      { x: bottomRight.x, y: topLeft.y },
    ].map(this.transform);
    return boundingBox(ps);
  }

  distanceTo(pos: Position) {
    return pointDist(pos, this);
  }

  moveBy(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    this.forEachHandle((h) => h.moveBy(dx, dy));
  }

  render(transform: Transform, color?: string, depth = 0) {
    this.master.render((pos) => transform(this.transform(pos)), color, depth);
    if (depth === 1) {
      // draw instance-side attachers
      this.attachers.withDo(this.master.attachers, (attacher, mAttacher) => {
        const tAttacher = transform(attacher);
        drawLine(
          transform(this.transform(mAttacher)),
          tAttacher,
          config().instanceSideAttacherColor,
        );
        drawPoint(tAttacher, config().instanceSideAttacherColor);
      });
    }
  }

  forEachHandle(fn: (h: Handle) => void): void {
    this.attachers.forEach(fn);
  }

  replaceHandle(oldHandle: Handle, newHandle: Handle) {
    this.attachers = this.attachers.map((h) => (h === oldHandle ? newHandle : h));
  }

  forEachVar(fn: (v: Var<number>) => void): void {
    fn(this.xVar);
    fn(this.yVar);
    fn(this.angleAndSizeVecX);
    fn(this.angleAndSizeVecY);
    this.forEachHandle((h) => h.forEachVar(fn));
  }
}
