import 'webgl-lint'; // for debugging
import * as twgl from 'twgl.js';
import * as dat from 'dat.gui';
import * as wrapper from './wrapper';
import * as NativeEvents from './NativeEvents';
import config from './config';
import { showHideConsole } from './console';

config().usePredictedEvents = true;
config().console = true;
showHideConsole();

// Simulate a CRT's glow by drawing into a phosphor texture,
// thereby "depositing" photons into the phosphor, and then
// drawing the texture to the screen, thereby "emitting"
// a fraction of the photons from the phosphor. Another pass
// removes those photons from the phosphor texture, "fading" it.
//
// This makes each phosphor texel glow for a few frames after
// being "hit" by the cathod ray, and then fade out over time.
//
// The phosphor texture is ping-ponged between two sim textures
// because we need to read from the previous frame's texture
// while writing to the current frame's texture.
//
// The phosphor texture is in linear space. When drawn to the
// screen, the values are gamma corrected to sRGB.

// TODO
// [x] Gaussian deposition of photons
// [x] UI for experimenting with parameters
// [ ] use for Sketchpad drawing
// [ ] use >8bit textures for higher dynamic range

const MAX_SPOTS = 16348;     // TX-2 used 32K for display table with double buffering

// Sketchpad used 36 bit words for spot locations in the display table:
// 10 bits from each of the two half-words for x and y,
// plus the remaining 16 bits as ID for lightpen

// we will use 10 bits out of the two half-words in a 32 bit word for x and y
const displayTable = new Int16Array(MAX_SPOTS*2);
let numSpots = 0;

///////// PUBLIC API //////////

export function init(canvas: HTMLCanvasElement) {
    startup(canvas);
}

export function clearSpots() {
    numSpots = 0;
}

export function addSpot(x: number, y: number) {
    displayTable[2*numSpots] = x;
    displayTable[2*numSpots+1] = y;
    numSpots++;
}

///////// IMPLEMENTATION //////////

const VERT_SHADER = `
attribute vec2 position;        // position of spot
uniform vec2 screenScale;       // half width/height of screen
uniform float spotSize;        // size of spot

void main() {
  gl_Position = vec4(position / screenScale, 0.0, 1.0);
  gl_PointSize = spotSize;
}`;

const SPOT_SHADER = `
precision mediump float;
void main() {
    float dist = distance(gl_PointCoord, vec2(0.5));
    float gauss = exp(-dist * 10.0);
    if (gauss < 0.01) discard;
    // src+dst blending to accumulate photons
    gl_FragColor = gauss * vec4(1.0);
}`;

const FADE_SHADER = `
precision mediump float;
uniform float fadeAmount;
void main() {
    vec4 color = vec4(0.0, 0.0, 0.0, fadeAmount);
    // dst*(1-src.a)) blending to fade out
    gl_FragColor = color;
}`;

const uniforms = {
    spotSize: 10,
    screenScale: [512, 512],
    fadeAmount: 0.2,
};

const params = {
    demoSpots: 4000,
    demoSpeed: 10,
    penTracker: true,
    fullscreen: false,
}

function startup(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })!;
    if (!gl) throw new Error('No WebGL2 context found');

    function resize() {
        twgl.resizeCanvasToDisplaySize(canvas, devicePixelRatio);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width/512, canvas.height/512);
        uniforms.screenScale = [canvas.width/scale, canvas.height/scale];
        // only draw inner square
        const ratio = canvas.width / canvas.height;
        const left = ratio > 1 ? (canvas.width - canvas.height) / 2 : 0;
        const top = ratio < 1 ? (canvas.height - canvas.width) / 2 : 0;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor( left, top, canvas.width - 2*left, canvas.height - 2*top);
    }
    onresize = () => resize();
    resize();

    const gui = new dat.GUI();
    gui.add(uniforms, 'spotSize', 1, 256);
    gui.add(uniforms, 'fadeAmount', 0, 1);
    gui.add(params, 'demoSpots', 1, MAX_SPOTS-348); // leave room for penTracker
    gui.add(params, 'demoSpeed', 0, 100);
    gui.add(params, 'fullscreen').onChange((on: boolean) => {
        if (on) document.body.requestFullscreen();
        else document.exitFullscreen();
    });

    const penLoc = { x: 0, y: 0 };
    function updatePen(x, y) {
        const b = canvas.getBoundingClientRect();
        penLoc.x = (x - b.left - b.width/2) / b.width * 2 * uniforms.screenScale[0] | 0;
        penLoc.y = (y - b.top - b.height/2) / b.height * -2 * uniforms.screenScale[1] | 0;
    };
    canvas.onpointermove = canvas.onpointerdown = canvas.onpointerup = (e) => {
        updatePen(e.clientX, e.clientY);
    }
    function processNativeEvents() {
        for (const event of NativeEvents.getQueuedEvents()) {
            if (event.type === 'pencil') updatePen(event.position.x, event.position.y);
        }
    }

    const fadeProg = twgl.createProgramInfo(gl, [VERT_SHADER, FADE_SHADER]);
    const fadeArrays: twgl.Arrays = {
        position: {
            numComponents: 2,
            data: [-512, -512, 512, -512, 512, 512, -512, 512],
        },
    };
    const fadeBuffers = twgl.createBufferInfoFromArrays(gl, fadeArrays);

    const spotsProg = twgl.createProgramInfo(gl, [VERT_SHADER, SPOT_SHADER]);
    const spotsArrays: twgl.Arrays = {
        position: {
            numComponents: 2,
            data: displayTable,
        },
    };
    const spotsBuffers = twgl.createBufferInfoFromArrays(gl, spotsArrays);

    let phase = 0;
    let prevTime = 0;
    function render(time: number) {
        phase += (time - prevTime) * params.demoSpeed / 10000;
        prevTime = time;

        processNativeEvents();

        // start add spots
        clearSpots();
        lissajous(400, 400, phase, 3, 4, params.demoSpots);
        penTracker(penLoc); // after all other spots
        // end add spots

        // update spots buffer
        twgl.setAttribInfoBufferFromArray(gl,
            spotsBuffers.attribs!.position,
            new Int16Array(displayTable.buffer, 0, numSpots*2));

        // render phosphor fade
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(fadeProg.program);
        twgl.setBuffersAndAttributes(gl, fadeProg, fadeBuffers);
        twgl.setUniforms(fadeProg, uniforms);
        twgl.drawBufferInfo(gl, fadeBuffers, gl.TRIANGLE_FAN);

        // render ray spots
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(spotsProg.program);
        twgl.setBuffersAndAttributes(gl, spotsProg, spotsBuffers);
        twgl.setUniforms(spotsProg, uniforms);
        twgl.drawBufferInfo(gl, spotsBuffers, gl.POINTS, numSpots);

        requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
}

let hadPseudoLoc = false;
function penTracker({ x, y}) {
    // log pattern from fig 4.4 of Sketchpad thesis (pg. 58)
    const COUNT = 6;          // number of spots per arm
    const START = 2;          // inner opening
    const DENSITY = 1.4;      // density of spots
    const PSEUDO = 0.5;       // snap distance for pseudo pen location
    const BRIGHT = 0.05;       // bright dot size for pseudo pen location
    const scale = Math.max(20, uniforms.spotSize);
    const pseudoRange = scale * PSEUDO;  // snap to spot this close
    // find closest spot, make it the pseudo pen location
    let pseudoX = x, pseudoY = y, dist = Infinity;
    for (let i = 0; i < numSpots; i++) {
        const dx = x - displayTable[2*i];
        if (dx > pseudoRange || dx < -pseudoRange) continue;
        const dy = y - displayTable[2*i+1];
        if (dy > pseudoRange || dy < -pseudoRange) continue;
        const d = Math.min(dx, dy);
        if (d < dist) {
            pseudoX = displayTable[2*i];
            pseudoY = displayTable[2*i+1];
            dist = d;
        }
    }
    // haptic feedback
    const hasPseudoLoc = dist < Infinity;
    if (hasPseudoLoc !== hadPseudoLoc) {
        if (hasPseudoLoc) {
            wrapper.send('prepareHaptics');
            wrapper.send('hapticImpact');
        }
        hadPseudoLoc = hasPseudoLoc;
    }
    // draw bright dot at pseudo pen location
    const r = scale * BRIGHT;
    for (const [ox, oy] of [[-2,-2], [-3,0], [-2,2], [0,-3], [0,0], [0,3], [2,-2], [3,0], [2,2]]) {
        addSpot(pseudoX + ox * r, pseudoY + oy * r);
    }
    // draw arms
    for (let i = 0; i < COUNT; i++) {
        const r = Math.log(START + i) / DENSITY * scale;
        for (const [ox, oy] of [[-1,0], [1,0], [0,-1], [0,1]]) {
            addSpot(x + ox * r, y + oy * r);
        }
    }
}

function lissajous(w: number, h: number, phase: number, a: number, b: number, nSpots: number) {
    for (let i = 0, angle = 0; i < nSpots; i++, angle += Math.PI * 2 / nSpots) {
        addSpot(
            Math.sin(a * angle + phase) * w,
            Math.cos(b * angle + phase) * h,
        );
    }
}
