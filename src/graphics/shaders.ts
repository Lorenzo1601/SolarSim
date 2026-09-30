/**
 * Shader dei corpi naturali (solo grafica).
 *
 *  - superficie: texture reali, luce dal Sole, terminatore morbido, regolite (Lommel-Seeliger),
 *    oscuramento al bordo dei giganti gassosi, luci notturne e riflesso degli oceani (Terra),
 *    rilievo (Luna), ombre di eclissi e ombra degli anelli di Saturno
 *  - nubi (Terra), guscio atmosferico con diffusione e tramonto al terminatore
 *  - anelli di Saturno illuminati dal lato giusto, con l'ombra del pianeta
 *  - Sole: granulazione animata, oscuramento al bordo, corona
 *
 * Eclissi e ombre usano la geometria REALE (posizioni del motore fisico in raggi del corpo):
 * nella scala logaritmica le distanze sono compresse e le ombre "di scena" sarebbero enormi.
 * Tutti gli shader includono il depth buffer logaritmico del renderer.
 */
import * as THREE from 'three';

export const MAX_OCCLUDERS = 8;

const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

/** Parte comune: eclissi (dischi Sole/occultatore) e ombra degli anelli, in raggi del corpo. */
const LIGHT_GLSL = /* glsl */ `
uniform vec3 sunPos;       // Sole rispetto al centro del corpo [raggi del corpo]
uniform float sunRadius;   // raggio del Sole [raggi del corpo]
uniform vec4 occ[${MAX_OCCLUDERS}]; // occultatori: centro (xyz) e raggio (w) [raggi del corpo]
uniform float occAtm[${MAX_OCCLUDERS}];
uniform int occCount;
uniform float hasRings;
uniform vec3 ringNormal;
uniform float ringInner;
uniform float ringOuter;
uniform sampler2D ringMap;

float angleBetween(vec3 a, vec3 b) { return atan(length(cross(a, b)), dot(a, b)); }

// frazione di luce solare che arriva in p (0 = eclisse totale); red = luce rifratta da un'atmosfera
float sunlight(vec3 p, out vec3 red) {
  red = vec3(0.0);
  vec3 toS = sunPos - p;
  float dS = length(toS);
  vec3 sd = toS / dS;
  float aS = asin(clamp(sunRadius / dS, 0.0, 1.0));
  float light = 1.0;
  for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= occCount) break;
    vec3 toO = occ[i].xyz - p;
    float dO = length(toO);
    if (dot(toO, sd) <= 0.0 || dO <= occ[i].w) continue;
    float aO = asin(clamp(occ[i].w / dO, 0.0, 1.0));
    float sep = angleBetween(toO, sd);
    float full = min(1.0, (aO * aO) / (aS * aS));
    float lo = abs(aS - aO);
    float cover = sep >= aS + aO ? 0.0 : (sep <= lo ? full : full * (1.0 - smoothstep(0.0, 1.0, (sep - lo) / (aS + aO - lo))));
    light *= 1.0 - cover;
    // eclissi di Luna: l'atmosfera terrestre rifrange luce rossa nel cono d'ombra
    red += occAtm[i] * cover * vec3(0.55, 0.16, 0.05) * 0.16;
  }
  if (hasRings > 0.5) {
    float den = dot(sd, ringNormal);
    if (abs(den) > 1e-5) {
      float t = -dot(p, ringNormal) / den;
      if (t > 0.0) {
        float r = length(p + sd * t);
        if (r > ringInner && r < ringOuter) {
          float a = texture2D(ringMap, vec2((r - ringInner) / (ringOuter - ringInner), 0.5)).a;
          light *= 1.0 - 0.92 * a;
        }
      }
    }
  }
  return light;
}
`;

const PLANET_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float flatK;      // 1 − schiacciamento
uniform float radiusScene;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vGeoNormal;
varying vec3 vObjNormal;
varying vec3 vRel;        // posizione relativa al centro [raggi equatoriali]
varying vec3 vViewPos;    // posizione rispetto alla camera (precisa: modelViewMatrix è in doppia precisione)
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vObjNormal = normal;
  vGeoNormal = normalize(mat3(modelMatrix) * vec3(normal.x, normal.y / (flatK * flatK), normal.z));
  vRel = (mat3(modelMatrix) * position) / radiusScene;
  vViewPos = (modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * vec4(vViewPos, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const PLANET_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform mat4 modelMatrix;
uniform float mapWidth;
${LIGHT_GLSL}
${NOISE_GLSL}
uniform sampler2D map;
uniform float hasMap;
uniform vec3 baseColor;
uniform vec3 tint;
uniform sampler2D normalMap;
uniform float hasNormal;
uniform float normalScale;
uniform sampler2D nightMap;
uniform float hasNight;
uniform sampler2D specMap;
uniform float hasSpec;
uniform sampler2D cloudMap;
uniform float hasClouds;
uniform float cloudOffset;
uniform float flatK;
uniform float regolith;
uniform float saturation;
uniform float limb;
uniform vec3 atmColor;
uniform float atmStrength;
uniform float ambient;
uniform vec3 bodyCenter;
uniform vec3 poleAxis;
uniform float radiusScene;
uniform mat3 objRot;
uniform vec3 camRel;
varying vec3 vViewPos;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vGeoNormal;
varying vec3 vObjNormal;
varying vec3 vRel;

void main() {
  #include <logdepthbuf_fragment>
  // Superficie "ray-traced": la mesh (leggermente più grande) serve solo a coprire i pixel; il colore,
  // la normale e la profondità vengono dall'ellissoide esatto. Così da vicino (un razzo in rampa, un
  // satellite in orbita bassa) il suolo non ha le sfaccettature della sfera poligonale.
  // raggio visivo in coordinate relative alla camera: niente differenze fra numeri grandi (float32)
  vec3 ro = camRel;
  vec3 rd = normalize((vec4(vViewPos, 0.0) * viewMatrix).xyz);
  float sk = 1.0 / flatK - 1.0;
  vec3 ro2 = ro + poleAxis * dot(ro, poleAxis) * sk;
  vec3 rd2 = rd + poleAxis * dot(rd, poleAxis) * sk;
  float qa = dot(rd2, rd2);
  float qb = dot(ro2, rd2);
  float qc = dot(ro2, ro2) - radiusScene * radiusScene;
  float qh = qb * qb - qa * qc;
  float tHit;
  if (qc < 0.0) {
    // camera dentro l'ellissoide (non dovrebbe succedere): si usa il triangolo
    tHit = length(vViewPos);
  } else {
    if (qh <= 0.0) discard;
    tHit = (-qb - sqrt(qh)) / qa;
    if (tHit <= 0.0) discard;
  }
  vec3 rel = (camRel + rd * tHit) / radiusScene;
  vec3 o = transpose(objRot) * rel;
  vec3 n0 = normalize(vec3(o.x, o.y / flatK, o.z));
  vec3 Ng = normalize(objRot * vec3(n0.x, n0.y / flatK, n0.z));
  float uu = atan(n0.z, -n0.x) / (2.0 * PI);
  vec2 uv = vec2(uu < 0.0 ? uu + 1.0 : uu, 1.0 - acos(clamp(n0.y, -1.0, 1.0)) / PI);
  vec2 gx = dFdx(vUv);
  vec2 gy = dFdy(vUv);
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  {
    vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    gl_FragDepth = log2(1.0 + dot(rd * tHit, fwd)) * logDepthBufFC * 0.5;
  }
  #endif
  vec3 N = Ng;
  if (hasNormal > 0.5) {
    vec3 east = cross(vec3(0.0, 1.0, 0.0), n0);
    if (dot(east, east) > 1e-6) {
      east = normalize(east);
      vec3 north = cross(n0, east);
      vec3 nm = textureGrad(normalMap, uv, gx, gy).xyz * 2.0 - 1.0;
      nm.xy *= normalScale;
      vec3 nObj = normalize(east * nm.x + north * nm.y + n0 * nm.z);
      N = normalize(objRot * vec3(nObj.x, nObj.y / flatK, nObj.z));
    }
  }
  vec3 L = normalize(sunPos - rel);
  vec3 V = -rd;
  float NgL = dot(Ng, L);
  float NdL = max(dot(N, L), 0.0);
  float NdV = max(dot(Ng, V), 1e-3);

  vec3 albedo = hasMap > 0.5 ? textureGrad(map, uv, gx, gy).rgb * tint : baseColor;
  albedo = mix(vec3(dot(albedo, vec3(0.2126, 0.7152, 0.0722))), albedo, saturation);
  // dettaglio procedurale quando un pixel della mappa copre molti pixel a video (primi piani al suolo)
  float texelPx = 1.0 / max(length(abs(gx) + abs(gy)) * mapWidth, 1e-9);
  if (texelPx > 2.0) {
    vec3 op = n0;
    float perPx = length(fwidth(op));
    float det = 0.0;
    float F = 600.0;
    for (int i = 0; i < 5; i++) {
      float cyclePx = 1.0 / max(F * perPx, 1e-9);
      float w = smoothstep(2.0, 10.0, cyclePx) * (1.0 - smoothstep(4000.0, 20000.0, cyclePx));
      det += snoise(op * F) * 0.5 * w;
      F *= 4.0;
    }
    albedo *= 1.0 + 0.22 * det * smoothstep(2.0, 8.0, texelPx);
  }
  float lambert = NdL;
  float lommel = 2.0 * NdL / (NdL + NdV);
  float diffuse = mix(lambert, lommel, regolith) * smoothstep(-0.03, 0.06, NgL);
  if (limb > 0.0) diffuse *= pow(NdV, limb);

  vec3 red;
  float sun = sunlight(rel, red);

  float clouds = 0.0;
  if (hasClouds > 0.5) {
    clouds = textureGrad(cloudMap, uv + vec2(cloudOffset, 0.0), gx, gy).r;
    // ombre delle nubi sul suolo (spostate verso l'antisolare)
    float sh = textureGrad(cloudMap, uv + vec2(cloudOffset + 0.0015, 0.0008), gx, gy).r;
    diffuse *= 1.0 - 0.35 * sh;
  }

  vec3 col = albedo * (diffuse * sun + ambient) + albedo * red * smoothstep(-0.03, 0.06, NgL);

  float day = smoothstep(-0.12, 0.35, NgL);
  if (hasSpec > 0.5) {
    float water = textureGrad(specMap, uv, gx, gy).r;
    vec3 H = normalize(L + V);
    float nh = max(dot(Ng, H), 0.0);
    float glint = pow(nh, 400.0) * 1.6 + pow(nh, 40.0) * 0.12;
    col += vec3(1.0, 0.93, 0.8) * glint * water * sun * smoothstep(0.0, 0.1, NgL) * (1.0 - clouds);
  }
  if (hasNight > 0.5) {
    float night = smoothstep(0.08, -0.18, NgL);
    col += textureGrad(nightMap, uv, gx, gy).rgb * night * (1.0 - 0.85 * clouds) * 1.6;
  }
  if (atmStrength > 0.0) {
    // diffusione atmosferica sul disco (più forte verso il bordo)
    float rim = pow(1.0 - NdV, 2.5);
    col += atmColor * atmStrength * (0.05 + 0.5 * rim) * day * sun;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CLOUD_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${LIGHT_GLSL}
uniform sampler2D cloudMap;
uniform float cloudOffset;
uniform float hasClouds;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vGeoNormal;
varying vec3 vObjNormal;
varying vec3 vRel;
void main() {
  #include <logdepthbuf_fragment>
  if (hasClouds < 0.5) discard;
  vec3 N = normalize(vGeoNormal);
  vec3 L = normalize(sunPos - vRel);
  float NgL = dot(N, L);
  float a = texture2D(cloudMap, vUv + vec2(cloudOffset, 0.0)).r;
  a = smoothstep(0.08, 0.9, a);
  vec3 red;
  float sun = sunlight(vRel, red);
  float lit = max(NgL, 0.0) * smoothstep(-0.05, 0.1, NgL);
  // al terminatore le nubi si tingono di arancio
  vec3 c = mix(vec3(1.0, 0.55, 0.3), vec3(1.0), smoothstep(0.0, 0.25, NgL));
  vec3 col = c * (lit * sun * 0.95 + 0.008) + red * 0.6;
  gl_FragColor = vec4(col, a * smoothstep(-0.35, 0.05, NgL) * 0.95);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ATMOSPHERE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 center;
uniform float rPlanet;
uniform float rAtm;
uniform vec3 sunDir;
uniform vec3 atmColor;
uniform vec3 sunsetColor;
uniform float strength;
uniform float sunFactor;
uniform vec3 poleAxis;
uniform float flatK;
varying vec3 vWorldPos;
// spazio "stirato" lungo l'asse polare: il pianeta schiacciato diventa una sfera
vec3 unflatten(vec3 v) { return v + poleAxis * dot(v, poleAxis) * (1.0 / flatK - 1.0); }
void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = center + unflatten(cameraPosition - center);
  vec3 rdw = normalize(vWorldPos - cameraPosition);
  vec3 rd = normalize(unflatten(rdw));
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - rAtm * rAtm;
  float h = b * b - c;
  if (h < 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0);
  float t1 = -b + h;
  float ci = dot(oc, oc) - rPlanet * rPlanet;
  float hi = b * b - ci;
  if (hi > 0.0) {
    float ti = -b - sqrt(hi);
    if (ti > 0.0) t1 = min(t1, ti);
  }
  float len = max(t1 - t0, 0.0);
  float H = rAtm - rPlanet;
  vec3 scat = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float t = t0 + len * (float(i) + 0.5) / 8.0;
    vec3 pos = ro + rd * t;
    float r = length(pos - center);
    float hh = clamp((r - rPlanet) / H, 0.0, 1.0);
    float dens = exp(-hh * 3.5) * (1.0 - hh) * (1.0 - hh);
    vec3 n = (pos - center) / r;
    float mu = dot(n, sunDir);
    float sunAmt = smoothstep(-0.28, 0.2, mu);
    float sunset = smoothstep(0.45, 0.0, mu) * sunAmt;
    scat += mix(atmColor, sunsetColor, sunset * 0.85) * dens * sunAmt;
  }
  scat *= (len / H) / 8.0;
  float cosT = dot(rdw, sunDir);
  float phase = 0.75 * (1.0 + cosT * cosT) + 0.6 * pow(max(cosT, 0.0), 12.0);
  vec3 col = scat * phase * strength * 0.11 * sunFactor;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RING_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float radiusScene;
varying vec3 vWorldPos;
varying vec3 vRel;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vRel = (mat3(modelMatrix) * position) / radiusScene;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const RING_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D ringMap;
uniform float ringInner;
uniform float ringOuter;
uniform vec3 ringNormal;
uniform vec3 sunPos;
varying vec3 vWorldPos;
varying vec3 vRel;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vRel);
  float u = (r - ringInner) / (ringOuter - ringInner);
  if (u < 0.0 || u > 1.0) discard;
  vec4 tex = texture2D(ringMap, vec2(u, 0.5));
  float alpha = tex.a;
  if (alpha < 0.004) discard;
  vec3 L = normalize(sunPos - vRel);
  vec3 V = normalize(cameraPosition - vWorldPos);
  // ombra del pianeta (sfera di raggio 1)
  float along = dot(vRel, L);
  float d = length(vRel - L * along);
  float shadow = along < 0.0 ? smoothstep(0.97, 1.03, d) : 1.0;
  float sL = dot(ringNormal, L);
  float sV = dot(ringNormal, V);
  float elev = abs(sL);
  float bright;
  if (sL * sV > 0.0) {
    // lato illuminato: diffusione multipla, poco dipendente dall'altezza del Sole
    bright = 0.35 + 0.65 * pow(elev, 0.3);
  } else {
    // lato in ombra: passa solo la luce trasmessa (le zone sottili brillano, l'anello B è scuro)
    bright = alpha * (1.0 - alpha) * 2.2 * pow(elev, 0.2) + 0.02;
  }
  // diffusione in avanti (controluce)
  float fwd = pow(max(dot(-V, L), 0.0), 8.0);
  vec3 col = tex.rgb * (bright + fwd * (1.0 - alpha) * 1.5) * shadow;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SUN_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
varying vec3 vN;
varying vec3 vWorldPos;
void main() {
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const SUN_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
uniform float time;
uniform float intensity;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vWorldPos;
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(cameraPosition - vWorldPos);
  float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
  vec3 p = normalize(vObj);
  // granulazione (celle convettive) + supergranulazione, lentamente variabili
  float g = 0.0;
  g += 0.55 * (1.0 - abs(snoise(p * 90.0 + vec3(0.0, time * 0.05, 0.0))));
  g += 0.3 * (1.0 - abs(snoise(p * 220.0 - vec3(time * 0.08))));
  g += 0.15 * snoise(p * 12.0 + vec3(time * 0.01));
  // macchie solari (rare) e facole
  float spots = snoise(p * 7.0 + vec3(7.1, time * 0.002, 1.3)) * 0.7 + snoise(p * 21.0 + 3.3) * 0.3;
  float lat = abs(p.y);
  float band = smoothstep(0.05, 0.2, lat) * smoothstep(0.55, 0.3, lat);
  float umbra = smoothstep(0.66, 0.72, spots) * band;
  float penumbra = smoothstep(0.58, 0.66, spots) * band;
  // oscuramento al bordo (legge quadratica, u≈0.6) e arrossamento
  float ld = 1.0 - 0.62 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);
  vec3 hot = vec3(1.0, 0.78, 0.45);
  vec3 limbCol = vec3(0.85, 0.3, 0.06);
  vec3 col = mix(limbCol, hot, pow(mu, 0.45));
  float gran = 0.72 + 0.42 * g;
  col *= gran * ld;
  col *= 1.0 - 0.45 * penumbra - 0.45 * umbra;
  col += vec3(1.0, 0.8, 0.5) * 0.12 * (1.0 - mu) * smoothstep(0.2, 0.6, g); // facole al bordo
  gl_FragColor = vec4(col * intensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CORONA_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const CORONA_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
uniform float time;
uniform float extent;     // metà lato del quadrato [raggi solari]
uniform float intensity;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = (vUv * 2.0 - 1.0) * extent;
  float r = length(q);
  if (r < 0.98) discard;
  float ang = atan(q.y, q.x);
  // pennacchi (streamer) e getti polari
  float s = snoise(vec3(cos(ang) * 2.2, sin(ang) * 2.2, time * 0.01));
  float s2 = snoise(vec3(cos(ang) * 7.0, sin(ang) * 7.0, time * 0.02 + 3.0));
  float streamers = 0.55 + 0.45 * s + 0.25 * s2;
  float k = r - 1.0;
  float inner = exp(-k * 9.0);
  float outer = pow(1.0 / r, 3.2) * streamers;
  float glow = pow(1.0 / r, 1.6) * 0.06;
  float edge = smoothstep(extent, extent * 0.6, r);
  vec3 col = vec3(1.0, 0.86, 0.66) * (inner * 0.9 + outer * 0.8) + vec3(1.0, 0.7, 0.4) * glow;
  gl_FragColor = vec4(col * intensity * edge, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ───────────────────────── Fabbriche di materiali ─────────────────────────

/** Uniform condivise fra superficie e nubi di uno stesso corpo (luce ed eclissi). */
export function createLightUniforms(): Record<string, THREE.IUniform> {
  return {
    sunPos: { value: new THREE.Vector3(1e4, 0, 0) },
    sunRadius: { value: 100 },
    occ: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) },
    occAtm: { value: new Array(MAX_OCCLUDERS).fill(0) },
    occCount: { value: 0 },
    hasRings: { value: 0 },
    ringNormal: { value: new THREE.Vector3(0, 1, 0) },
    ringInner: { value: 1.1 },
    ringOuter: { value: 2.3 },
    ringMap: { value: null },
    flatK: { value: 1 },
    radiusScene: { value: 1 },
  };
}

export function createPlanetMaterial(light: Record<string, THREE.IUniform>, baseColor: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...light,
      map: { value: null },
      hasMap: { value: 0 },
      baseColor: { value: baseColor },
      tint: { value: new THREE.Vector3(1, 1, 1) },
      normalMap: { value: null },
      hasNormal: { value: 0 },
      normalScale: { value: 1 },
      nightMap: { value: null },
      hasNight: { value: 0 },
      specMap: { value: null },
      hasSpec: { value: 0 },
      cloudMap: { value: null },
      hasClouds: { value: 0 },
      cloudOffset: { value: 0 },
      regolith: { value: 0 },
      saturation: { value: 1 },
      limb: { value: 0 },
      atmColor: { value: new THREE.Vector3() },
      atmStrength: { value: 0 },
      ambient: { value: 0.012 },
      bodyCenter: { value: new THREE.Vector3() },
      mapWidth: { value: 2048 },
      objRot: { value: new THREE.Matrix3() },
      camRel: { value: new THREE.Vector3() },
      poleAxis: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: PLANET_VERTEX,
    fragmentShader: PLANET_FRAGMENT,
  });
}

export function createCloudMaterial(light: Record<string, THREE.IUniform>, surface: THREE.ShaderMaterial): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...light,
      cloudMap: surface.uniforms.cloudMap,
      cloudOffset: surface.uniforms.cloudOffset,
      hasClouds: surface.uniforms.hasClouds,
    },
    vertexShader: PLANET_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
}

export function createAtmosphereMaterial(color: THREE.Vector3, sunset: THREE.Vector3, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      center: { value: new THREE.Vector3() },
      rPlanet: { value: 1 },
      rAtm: { value: 1.03 },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      atmColor: { value: color },
      sunsetColor: { value: sunset },
      strength: { value: strength },
      sunFactor: { value: 1 },
      poleAxis: { value: new THREE.Vector3(0, 1, 0) },
      flatK: { value: 1 },
    },
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function createRingMaterial(light: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ringMap: light.ringMap,
      ringInner: light.ringInner,
      ringOuter: light.ringOuter,
      ringNormal: light.ringNormal,
      sunPos: light.sunPos,
      radiusScene: light.radiusScene,
    },
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function createSunMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, intensity: { value: 1.35 } },
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
  });
}

export function createCoronaMaterial(extent: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, extent: { value: extent }, intensity: { value: 1.6 } },
    vertexShader: CORONA_VERTEX,
    fragmentShader: CORONA_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
