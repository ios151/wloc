import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { parseCoords, gcj02ToWgs84, toWgs84, round6, inRange } from "./parse.js";

const app = new Hono();

app.get("/", (c) => {
  return c.html(getPageHtml());
});

// 地图链接解析: 供快捷指令调用。
// GET /api/parse?u=<链接>&format=json&cs=<gcj|none>
//   返回 {lat, lon, name}; 高德/苹果地图(中国大陆均为 GCJ-02)自动转 WGS84; 境外坐标自动跳过(out_of_china)。cs=none 可强制不转换。
//   不带 format=json 时返回纯文本 "lat=..&lon=.." 片段。
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // 默认按来源自动换算; cs=none 强制不转换, cs=gcj/bd 强制按指定坐标系转换。
    if (cs === "gcj") ({ lat, lon } = gcj02ToWgs84(lat, lon));
    else if (cs === "bd") ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    else if (cs !== "none") ({ lat, lon } = toWgs84(lat, lon, src));
    // 出口再校验一次: cs= 是调用方指定的, 强行按错误坐标系换算也可能把值推出值域。
    // 宁可报错也不要返回一个能被当成坐标写进设备的数字。
    if (!inRange(lat, lon)) throw new Error("解析出的坐标超出合法范围");
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

// 全球地点搜索: 供 app 的「全球」模式调用。
// GET /api/search?q=<关键词>
//   转发 OpenStreetMap Nominatim, 返回 {results:[{name, detail, lat, lon}]} (均为 WGS-84)。
//   按关键词边缘缓存 7 天 —— 地名基本不变, 重复搜索不回源, 既快又避开 Nominatim 的限速。
app.get("/api/search", async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ results: [] });

  const cache = caches.default;
  const cacheKey = new Request(
    `https://wloc.search.cache/?q=${encodeURIComponent(q.toLowerCase())}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) return c.json(await cached.json());

  const api =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`;
  let raw;
  try {
    const resp = await fetch(api, {
      headers: {
        // Nominatim 使用政策要求标识调用方, 不带会被拒。
        "User-Agent": "wloc-ios-place-search/1.0",
        "Accept-Language": "zh-CN,zh,en",
      },
    });
    if (!resp.ok) return c.json({ results: [] });
    raw = await resp.json();
  } catch {
    return c.json({ results: [] });
  }

  const results = (Array.isArray(raw) ? raw : [])
    .map((r) => ({
      name: r.name || String(r.display_name || "").split(",")[0].trim(),
      detail: r.display_name || "",
      lat: Number(r.lat),
      lon: Number(r.lon),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));

  const payload = { results };
  // 存一份带 TTL 的副本; waitUntil 不阻塞本次返回。
  c.executionCtx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=604800",
        },
      })
    )
  );
  return c.json(payload);
});

// 坐标反查地名: 供 app 在系统地理编码查不到时回落。
// GET /api/reverse?lat=<纬度>&lon=<经度>
//   转发 Nominatim 的 reverse 接口, 返回 {name, detail} (传入传出均为 WGS-84)。
//   大陆设备的系统地理编码数据源是高德, 境外基本没有覆盖 —— 定位到首尔只能
//   显示一串坐标, 补的就是这一块。搜索那边早有 /api/search 走这条路, 反查一直缺。
//   缓存键把坐标截到 4 位小数(约 11 米): 再精细就没有命中率了, 而同一栋楼的
//   不同角落本来也该是同一个地名。
app.get("/api/reverse", async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inRange(lat, lon)) {
    return c.json({ name: "", detail: "" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `https://wloc.reverse.cache/?at=${lat.toFixed(4)},${lon.toFixed(4)}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) return c.json(await cached.json());

  // zoom=18 大致是「门牌 / 建筑」这一级, 再往下 Nominatim 也给不出更多东西。
  const api =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lon}`;
  let raw;
  try {
    const resp = await fetch(api, {
      headers: {
        // 同 /api/search: Nominatim 使用政策要求标识调用方, 不带会被拒。
        "User-Agent": "wloc-ios-place-search/1.0",
        // 带上中文, 境外地名也能返回「首尔特别市」而不是 Seoul。
        "Accept-Language": "zh-CN,zh,en",
      },
    });
    if (!resp.ok) return c.json({ name: "", detail: "" });
    raw = await resp.json();
  } catch {
    return c.json({ name: "", detail: "" });
  }

  // 由近及远取第一个有值的: 路名最接近「我在哪」, 实在没有才退到行政区。
  const a = (raw && raw.address) || {};
  const name =
    (raw && raw.name) ||
    a.road ||
    a.pedestrian ||
    a.footway ||
    a.neighbourhood ||
    a.quarter ||
    a.suburb ||
    a.city_district ||
    a.town ||
    a.village ||
    a.city ||
    "";

  const payload = {
    name: String(name).trim(),
    detail: String((raw && raw.display_name) || "").trim(),
  };

  c.executionCtx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=604800",
        },
      })
    )
  );
  return c.json(payload);
});

// 兜底 500 也要带 CORS —— 否则快捷指令那边看到的是跨域错误, 而不是真正的原因。
app.onError((e, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  return c.text(`${e && e.message ? e.message : e}`, 500);
});

export default app;
