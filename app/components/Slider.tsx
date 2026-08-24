"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

const SLIDES = [
  "/slider/1.jpg",
  "/slider/2.jpg",
  "/slider/3.jpg",
  "/slider/4.jpg",
  "/slider/5.jpg",
  "/slider/6.jpg",
];

/* Whole-slider lens: the deformation profile lives in SCREEN space,
   not per image. Every vertex computes its viewport y, and the column
   swells around the viewport center (cos falloff to the edges) by the
   scroll speed — so all the images bulge together as one continuous
   surface. uAmt = 0 → plain rectangles (normal scrolling / at rest) */
const VERTEX_SHADER = /* glsl */ `
  uniform float uAmt;
  uniform float uPosY;
  uniform vec2 uPlaneSize;
  uniform float uLensR;
  varying vec2 vUv;

  void main() {
    vec3 pos = position;

    /* vertex position on screen (world px, viewport center = 0,0) */
    vec2 w = vec2(
      position.x * uPlaneSize.x,
      uPosY + position.y * uPlaneSize.y
    );

    /* RADIAL lens — like a sphere sitting under the slider: distance
       from the viewport center decides the magnification, 1 at the
       center easing to 0 at the sphere's radius. Points get pushed
       straight away from the center, so the middle image wraps over
       the ball and the neighbours curve around it. */
    /* smoothstep falloff: zero slope at BOTH the center and the rim,
       so the field has no crease anywhere — the column flows over the
       globe without any hard cut at the lens edge */
    float r = length(w) / uLensR;
    float profile = 1.0 - smoothstep(0.0, 1.0, r);
    vec2 displaced = w * (1.0 + uAmt * profile);

    /* back to this plane's local space */
    pos.x = displaced.x / uPlaneSize.x;
    pos.y = (displaced.y - uPosY) / uPlaneSize.y;

    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uTexture;
  uniform vec2 uPlaneSize;
  uniform vec2 uImageSize;
  uniform float uRadius;
  varying vec2 vUv;

  void main() {
    /* object-fit: cover */
    float rs = uPlaneSize.x / uPlaneSize.y;
    float ri = uImageSize.x / uImageSize.y;
    vec2 st = rs < ri
      ? vec2(uImageSize.x * uPlaneSize.y / uImageSize.y, uPlaneSize.y)
      : vec2(uPlaneSize.x, uImageSize.y * uPlaneSize.x / uImageSize.x);
    vec2 offset = (st - uPlaneSize) * 0.5;
    vec2 uv = (vUv * uPlaneSize + offset) / st;

    vec4 tex = texture2D(uTexture, uv);

    /* rounded corners via rounded-box SDF, in pixels */
    vec2 p = (vUv - 0.5) * uPlaneSize;
    vec2 b = uPlaneSize * 0.5 - vec2(uRadius);
    vec2 d = abs(p) - b;
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uRadius;
    float alpha = 1.0 - smoothstep(-1.0, 1.0, dist);

    gl_FragColor = vec4(tex.rgb, alpha);
  }
`;

/* ---------- Tuning ---------- */

const CONFIG = {
  scrollLerp: 0.035, // how fast the slider follows the wheel
  velocitySmooth: 0.42, // velocity smoothing (lower = lazier lens)
  lensSensitivity: 0.026, // scroll speed → lens strength
  lensMax: 0.53, // lens strength cap
  lensRadius: 0.5, // sphere radius, as a fraction of viewport height
  lensEase: 0.085, // how smoothly the bulge grows/settles (lower = softer)
  wheelMultiplier: 1.8, // scroll speed: how far one wheel notch travels
  itemWidth: 0.24, // image width, as a fraction of viewport width
  itemMaxWidth: 460, // image width cap (px)
  itemRatio: 0.65, // image height = width × ratio
  gap: 0.015, // gap between images, as a fraction of viewport height
  cornerRadius: 6, // image corner radius (px)
  touchMultiplier: 4.4, // touch drag speed
};

export default function Slider() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 10, 4000);

    /* layout metrics, recomputed on resize (1 world unit == 1 CSS px) */
    let vw = 0;
    let vh = 0;
    let itemW = 0;
    let itemH = 0;
    let gap = 0;
    let step = 0; // itemH + gap
    let total = 0; // full loop height

    const geometry = new THREE.PlaneGeometry(1, 1, 64, 64);
    const loader = new THREE.TextureLoader();

    const planes = SLIDES.map((src) => {
      const uniforms = {
        uTexture: { value: null as THREE.Texture | null },
        uImageSize: { value: new THREE.Vector2(1, 1) },
        uPlaneSize: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 6 },
        uAmt: { value: 0 },
        uPosY: { value: 0 },
        uLensR: { value: 1 },
      };
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.ShaderMaterial({
          transparent: true,
          /* painter's order only — renderOrder decides stacking, so an
             overlapping bulged image never gets depth-cut by a neighbour */
          depthTest: false,
          depthWrite: false,
          uniforms,
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
        }),
      );
      mesh.visible = false;
      scene.add(mesh);
      loader.load(src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        uniforms.uTexture.value = tex;
        uniforms.uImageSize.value.set(tex.image.width, tex.image.height);
        mesh.visible = true;
      });
      return { mesh, uniforms };
    });

    const resize = () => {
      vw = window.innerWidth;
      vh = window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(vw, vh);
      camera.aspect = vw / vh;
      camera.position.z = vh / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.updateProjectionMatrix();

      const c = CONFIG;
      /* phones: the desktop fraction would give tiny ~90px images, so
         widen the column to most of the screen */
      const widthFrac = vw < 768 ? 0.72 : c.itemWidth;
      itemW = Math.min(vw * widthFrac, c.itemMaxWidth);
      itemH = itemW * c.itemRatio;
      gap = vh * c.gap;
      step = itemH + gap;
      total = step * SLIDES.length;

      for (const p of planes) {
        p.mesh.scale.set(itemW, itemH, 1);
        p.uniforms.uPlaneSize.value.set(itemW, itemH);
        p.uniforms.uRadius.value = c.cornerRadius;
      }
    };
    resize();
    window.addEventListener("resize", resize);

    /* ---------- virtual scroll ---------- */
    let target = 0; // where the wheel wants to be
    let current = 0; // smoothed position
    let velocity = 0; // smoothed velocity, drives the distortion

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      target += e.deltaY * CONFIG.wheelMultiplier;
    };
    let touchY = 0;
    /* touch: drag + flick momentum, so lifting the finger coasts
       smoothly instead of stopping dead */
    let touchMomentum = 0;
    let touching = false;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
      touchMomentum = 0;
      touching = true;
    };
    const onTouchMove = (e: TouchEvent) => {
      /* the canvas owns the gesture — no page rubber-banding */
      e.preventDefault();
      const y = e.touches[0].clientY;
      const delta = (touchY - y) * CONFIG.touchMultiplier;
      target += delta;
      touchMomentum = delta;
      touchY = y;
    };
    const onTouchEnd = () => {
      touching = false; // momentum decays inside the RAF loop
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });

    let lensAmt = 0; // eased lens strength, trails the speed smoothly
    let raf = 0;

    const loop = () => {
      const c = CONFIG;

      /* touch flick inertia: keep coasting after the finger lifts */
      if (!touching && Math.abs(touchMomentum) > 0.1) {
        target += touchMomentum;
        touchMomentum *= 0.95;
      }

      /* smooth follow + velocity estimate */
      const prev = current;
      current += (target - current) * c.scrollLerp;
      const rawVel = current - prev;
      velocity += (rawVel - velocity) * c.velocitySmooth;

      /* lens strength from speed, shaped by easeOutCubic so it ramps
         gently instead of hitting the cap with a hard linear edge... */
      const t = THREE.MathUtils.clamp(
        (Math.abs(velocity) * c.lensSensitivity) / c.lensMax,
        0,
        1,
      );
      const easedTarget = c.lensMax * (1 - Math.pow(1 - t, 3));
      /* ...then eased again over time, so the bulge grows and settles
         softly rather than snapping with the velocity */
      lensAmt += (easedTarget - lensAmt) * c.lensEase;
      const speedAmt = lensAmt;
      const lensR = vh * c.lensRadius;

      for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        /* infinite wrap: keep every plane inside one loop-length band
           centered on the viewport */
        let y = (((i * step - current) % total) + total) % total;
        if (y > total / 2) y -= total;
        p.mesh.position.set(0, -y, 0);
        /* the image nearest the viewport center draws on top, so the
           bulge slides OVER its neighbours instead of being cut */
        p.mesh.renderOrder = Math.round(1000 - Math.abs(y));

        /* every plane shares the same lens; the shader reads its
           screen position and bends the whole column as one surface */
        p.uniforms.uAmt.value = speedAmt;
        p.uniforms.uPosY.value = -y;
        p.uniforms.uLensR.value = lensR;
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      for (const p of planes) {
        (p.mesh.material as THREE.ShaderMaterial).dispose();
        p.uniforms.uTexture.value?.dispose();
      }
      geometry.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <section className="relative h-screen w-full touch-none overflow-hidden overscroll-none bg-[#191919] font-sans text-white">
      <div ref={mountRef} className="absolute inset-0" />
    </section>
  );
}
