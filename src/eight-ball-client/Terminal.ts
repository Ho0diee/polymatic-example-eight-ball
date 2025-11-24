import { Dataset, Driver, Memo, Middleware } from "polymatic";

import { CueStick, Ball, Pocket, Rail, Table, type BilliardContext } from "../eight-ball/BilliardContext";

const SVG_NS = "http://www.w3.org/2000/svg";

const STROKE_WIDTH = 0.006 / 2;

// Quaternion helper
class Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;

  constructor(w: number = 1, x: number = 0, y: number = 0, z: number = 0) {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static fromAxisAngle(axis: { x: number; y: number; z: number }, angle: number) {
    const halfAngle = angle / 2;
    const s = Math.sin(halfAngle);
    return new Quaternion(Math.cos(halfAngle), axis.x * s, axis.y * s, axis.z * s);
  }

  multiply(q: Quaternion) {
    const w = this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z;
    const x = this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y;
    const y = this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x;
    const z = this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w;
    return new Quaternion(w, x, y, z);
  }

  normalize() {
    const len = Math.sqrt(this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z);
    if (len === 0) return this;
    this.w /= len;
    this.x /= len;
    this.y /= len;
    this.z /= len;
    return this;
  }

  rotateVector(v: { x: number; y: number; z: number }) {
    const qv = new Quaternion(0, v.x, v.y, v.z);
    const qConjugate = new Quaternion(this.w, -this.x, -this.y, -this.z);
    const qResult = this.multiply(qv).multiply(qConjugate);
    return { x: qResult.x, y: qResult.y, z: qResult.z };
  }
}

/**
 * Implements rendering and collecting user-input
 */
export class Terminal extends Middleware<BilliardContext> {
  container: SVGGElement;

  scorecardGroup: SVGGElement;
  ballsGroup: SVGGElement;
  tableGroup: SVGGElement;
  cueGroup: SVGGElement;

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);
    this.on("main-start", this.handleStart);

    this.dataset.addDriver(this.tableDriver);
    this.dataset.addDriver(this.railDriver);
    this.dataset.addDriver(this.pocketDriver);

    this.dataset.addDriver(this.ballDriver);

    this.dataset.addDriver(this.cueDriver);

    this.scorecardGroup = document.createElementNS(SVG_NS, "g");
    this.ballsGroup = document.createElementNS(SVG_NS, "g");
    this.tableGroup = document.createElementNS(SVG_NS, "g");
    this.cueGroup = document.createElementNS(SVG_NS, "g");

    this.container = document.createElementNS(SVG_NS, "g");
    this.container.classList.add("billiards");

    // Order matters for z-index
    this.container.appendChild(this.tableGroup);
    this.container.appendChild(this.ballsGroup);
    this.container.appendChild(this.cueGroup); // Cue on top of balls
    this.container.appendChild(this.scorecardGroup);
  }

  handleActivate() {
    const svg = document.getElementById("polymatic-eight-ball");
    if (svg && svg instanceof SVGSVGElement) {
      svg.appendChild(this.container);
      this.container.parentElement?.addEventListener("pointerdown", this.handlePointerDown);
      this.container.parentElement?.addEventListener("pointermove", this.handlePointerMove);
      this.container.parentElement?.addEventListener("pointerup", this.handlePointerUp);
      window.addEventListener("resize", this.handleWindowResize);
      window.addEventListener("orientationchange", this.handleWindowResize);
      this.handleWindowResize();
    } else {
      console.error("Container SVG element not found");
    }
  }

  handleDeactivate() {
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("orientationchange", this.handleWindowResize);
    this.container.parentElement?.removeEventListener("pointerdown", this.handlePointerDown);
    this.container.parentElement?.removeEventListener("pointermove", this.handlePointerMove);
    this.container.parentElement?.removeEventListener("pointerup", this.handlePointerUp);
    this.container.remove();
  }

  handleStart() {}

  // Store ball rotation state
  ballState = new Map<string, { q: Quaternion; pos: { x: number; y: number } }>();

  tableConfigMemo = Memo.init();
  handleWindowResize = () => {
    const table = this.context?.table;
    if (!this.container || !table) return;
    if (this.tableConfigMemo.update(table.width, table.height, window.innerWidth, window.innerHeight)) {
      const width = table.width * 1.3;
      const height = table.height * 1.3;
      const isPortrait = window.innerWidth < window.innerHeight;
      if (isPortrait) {
        this.container.classList.add("portrait");
        this.container.parentElement?.setAttribute("viewBox", `-${height * 0.5} -${width * 0.5} ${height} ${width}`);
      } else {
        this.container.classList.remove("portrait");
        this.container.parentElement?.setAttribute("viewBox", `-${width * 0.5} -${height * 0.5} ${width} ${height}`);
      }
    }
  };

  getSvgPoint = (event: PointerEvent) => {
    if (!this.container) return;
    const domPoint = new DOMPoint(event.clientX, event.clientY);
    const transform = this.container.getScreenCTM();
    if (!transform) return;
    const svgPoint = domPoint.matrixTransform(transform.inverse());
    return svgPoint;
  };

  pointerDown = false;

  handlePointerDown = (event: PointerEvent) => {
    this.pointerDown = true;
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.emit("user-pointer-start", point);
  };

  handlePointerMove = (event: PointerEvent) => {
    // if (!this.context.next) return;
    if (!this.pointerDown) return;
    event.preventDefault();
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.emit("user-pointer-move", point);
  };

  handlePointerUp = (event: PointerEvent) => {
    this.pointerDown = false;
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.emit("user-pointer-end", point);
  };

  handleFrameLoop = () => {
    if (!this.context.balls || !this.context.rails || !this.context.pockets) return;

    this.dataset.data([
      this.context.table,
      ...this.context.rails,
      ...this.context.pockets,
      ...this.context.balls,
      this.context.cue,
    ]);
  };

  ballDriver = Driver.create<Ball, Element>({
    filter: (data) => data.type == "ball",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("ball-group");
      
      // Initialize state if not exists
      if (!this.ballState.has(data.key)) {
        this.ballState.set(data.key, { 
          q: new Quaternion(), 
          pos: { ...data.position } 
        });
      }

      // Determine ball properties
      let number: number | null = null;
      let type: 'solid' | 'stripe' | 'cue' | '8' = 'solid';
      
      if (data.color === 'white') {
        type = 'cue';
      } else if (data.color === 'black') {
        number = 8;
        type = '8';
      } else {
        const parts = data.color.split('-');
        const colorName = parts[0];
        const style = parts[1];
        
        const colorToNumber: Record<string, number> = {
          'yellow': 1, 'blue': 2, 'red': 3, 'purple': 4, 
          'orange': 5, 'green': 6, 'burgundy': 7
        };
        
        if (colorToNumber[colorName]) {
          number = colorToNumber[colorName];
          if (style === 'stripe') {
            number += 8;
            type = 'stripe';
          }
        }
      }

      const r = data.radius - STROKE_WIDTH;

      // 1. Base Circle (The main color)
      const baseCircle = document.createElementNS(SVG_NS, "circle");
      baseCircle.setAttribute("r", String(r));
      baseCircle.classList.add("ball-circle");
      
      // For stripes, the base is the COLOR (we will draw white caps on top)
      // For solids, the base is the COLOR
      // For cue, base is white
      if (type === 'cue') {
        baseCircle.classList.add("ball", "white");
      } else if (type === '8') {
        baseCircle.classList.add("ball", "black");
      } else {
        // Both solid and stripe get the color base
        baseCircle.classList.add("ball", data.color.split('-')[0]);
      }
      group.appendChild(baseCircle);

      // 2. Dynamic Elements Group (Caps, Number)
      const dynamicGroup = document.createElementNS(SVG_NS, "g");
      group.appendChild(dynamicGroup);

      // 3. Gloss/Highlight (Fixed on top)
      const highlight = document.createElementNS(SVG_NS, "circle");
      highlight.setAttribute("r", String(r * 0.9));
      highlight.setAttribute("cx", String(-r * 0.2));
      highlight.setAttribute("cy", String(-r * 0.2));
      highlight.classList.add("ball-highlight");
      group.appendChild(highlight);

      // Store metadata for update
      (group as any).__ballMeta = { type, number, r, dynamicGroup };

      this.ballsGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {
      element.setAttribute("transform", `translate(${data.position.x}, ${data.position.y})`);

      const meta = (element as any).__ballMeta;
      if (!meta) return;
      const { type, number, r, dynamicGroup } = meta;

      // Update Rotation State
      let state = this.ballState.get(data.key);
      if (!state) {
         state = { q: new Quaternion(), pos: { ...data.position } };
         this.ballState.set(data.key, state);
      }

      // Calculate movement delta
      const dx = data.position.x - state.pos.x;
      const dy = data.position.y - state.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Update stored position
      state.pos.x = data.position.x;
      state.pos.y = data.position.y;

      // Update Quaternion based on rolling
      if (dist > 0.0001) {
        // Axis is perpendicular to movement
        const axis = { x: -dy / dist, y: dx / dist, z: 0 };
        const angle = dist / data.radius; // radians
        const qRot = Quaternion.fromAxisAngle(axis, angle);
        state.q = qRot.multiply(state.q).normalize();
      }
      
      // Clear dynamic elements
      while (dynamicGroup.firstChild) {
        dynamicGroup.removeChild(dynamicGroup.firstChild);
      }

      // Define vectors
      // Number is at (0, 0, 1)
      const vecNumber = state.q.rotateVector({ x: 0, y: 0, z: 1 });
      const vecNumberRight = state.q.rotateVector({ x: 1, y: 0, z: 0 });
      const vecNumberUp = state.q.rotateVector({ x: 0, y: 1, z: 0 });
      
      // Render Stripe Caps (White)
      if (type === 'stripe') {
        // Cap 1 at (0, 1, 0)
        const vecCap1 = state.q.rotateVector({ x: 0, y: 1, z: 0 });
        const vecCap1Right = state.q.rotateVector({ x: 1, y: 0, z: 0 });
        const vecCap1Up = state.q.rotateVector({ x: 0, y: 0, z: 1 });

        // Cap 2 at (0, -1, 0)
        const vecCap2 = state.q.rotateVector({ x: 0, y: -1, z: 0 });
        const vecCap2Right = state.q.rotateVector({ x: 1, y: 0, z: 0 });
        const vecCap2Up = state.q.rotateVector({ x: 0, y: 0, z: -1 });

        const drawCap = (pos: any, right: any, up: any) => {
          if (pos.z > -0.2) { 
            const cap = document.createElementNS(SVG_NS, "circle");
            // Use matrix transform for perspective
            const m = [right.x * r, right.y * r, up.x * r, up.y * r, pos.x * r, pos.y * r];
            cap.setAttribute("transform", `matrix(${m.join(',')})`);
            
            cap.setAttribute("r", "0.75"); // Unit radius relative to ball radius
            cap.setAttribute("fill", "white");
            dynamicGroup.appendChild(cap);
          }
        };
        drawCap(vecCap1, vecCap1Right, vecCap1Up);
        drawCap(vecCap2, vecCap2Right, vecCap2Up);
      }

      // Render Number Spot (White)
      if (number !== null) {
        if (vecNumber.z > -0.4) { // Visible
          const spot = document.createElementNS(SVG_NS, "g");
          // Use matrix transform for perfect surface adhesion
          const m = [vecNumberRight.x * r, vecNumberRight.y * r, vecNumberUp.x * r, vecNumberUp.y * r, vecNumber.x * r, vecNumber.y * r];
          spot.setAttribute("transform", `matrix(${m.join(',')})`);
          
          const spotCircle = document.createElementNS(SVG_NS, "circle");
          spotCircle.setAttribute("r", "0.45"); // Unit size
          spotCircle.setAttribute("fill", "white");
          spot.appendChild(spotCircle);

          const text = document.createElementNS(SVG_NS, "text");
          text.textContent = String(number);
          text.classList.add("ball-text");
          text.setAttribute("dy", "0.1em");
          text.setAttribute("font-size", "0.5"); // Unit size
          // Counter-scale text slightly if it gets too squished? 
          // No, let it squish, that's the effect.
          spot.appendChild(text);

          dynamicGroup.appendChild(spot);
        }
      }
    },
    exit: (data, element) => {
      this.ballState.delete(data.key);
      element.remove();
    },
  });

  tableDriver = Driver.create<Table, Element>({
    filter: (data) => data.type == "table",
    enter: (data) => {
      const element = document.createElementNS(SVG_NS, "rect");
      const w = data.width + data.pocketRadius * 1.5;
      const h = data.height + data.pocketRadius * 1.5;
      element.setAttribute("x", String(-w * 0.5 - STROKE_WIDTH));
      element.setAttribute("y", String(-h * 0.5 - STROKE_WIDTH));
      element.setAttribute("width", String(w + STROKE_WIDTH * 2));
      element.setAttribute("height", String(h + STROKE_WIDTH * 2));
      element.classList.add("table");
      this.tableGroup.appendChild(element);

      this.handleWindowResize();
      return element;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  railDriver = Driver.create<Rail, Element>({
    filter: (data) => data.type == "rail",
    enter: (data) => {
      const element = document.createElementNS(SVG_NS, "polygon");
      element.setAttribute("points", String(data.vertices?.map((v) => `${v.x},${v.y}`).join(" ")));
      element.classList.add("rail");
      this.tableGroup.appendChild(element);
      return element;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  pocketDriver = Driver.create<Pocket, Element>({
    filter: (data) => data.type == "pocket",
    enter: (data) => {
      const element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", String(data.position.x));
      element.setAttribute("cy", String(data.position.y));
      element.setAttribute("r", String(data.radius));
      element.classList.add("pocket");
      this.tableGroup.appendChild(element);
      return element;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  cueDriver = Driver.create<CueStick, Element>({
    filter: (data) => data.type == "cue",
    enter: (data) => {
      const element = document.createElementNS(SVG_NS, "line");
      element.classList.add("cue");
      this.cueGroup.appendChild(element);
      return element;
    },
    update: (data, element) => {
      element.setAttribute("x1", String(data.start.x));
      element.setAttribute("y1", String(data.start.y));
      element.setAttribute("x2", String(data.end.x));
      element.setAttribute("y2", String(data.end.y));
    },
    exit: (data, element) => {
      element.remove();
    },
  });

  dataset = Dataset.create<Ball | Rail | Pocket | CueStick | Table>({
    key: (data) => data.key,
  });
}
