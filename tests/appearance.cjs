const assert = require("node:assert/strict");
const path = require("node:path");
const key = "pi-desktop.appearance.v1";
async function apply(page, patch) {
  await page.evaluate(
    ({ key, patch }) => {
      const prefs = {
        ...JSON.parse(localStorage.getItem(key) || "{}"),
        ...patch,
      };
      localStorage.setItem(key, JSON.stringify(prefs));
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: JSON.stringify(prefs) }),
      );
    },
    { key, patch },
  );
  await page.waitForTimeout(45);
}
module.exports = async function appearance(page, output) {
  const checks = [];
  for (const preset of ["alpine", "dark", "light"])
    for (const style of ["flat", "3d"])
      for (const scale of [90, 100, 110, 125, 150])
        for (const size of [
          [960, 680],
          [1280, 800],
          [1440, 900],
        ]) {
          await page.setViewportSize({ width: size[0], height: size[1] });
          await apply(page, { preset, style, scale });
          const layout = await page.evaluate(() => {
            const root = document.documentElement,
              heading = document.querySelector(".appearance-heading"),
              box = heading.getBoundingClientRect();
            return {
              theme: root.dataset.theme,
              style: root.dataset.style,
              density: root.dataset.density,
              width: innerWidth,
              right: box.right,
              top: box.top,
              heading: box.width,
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
            };
          });
          assert.equal(layout.theme, preset);
          assert.equal(layout.style, style);
          assert.ok(
            !layout.overflow &&
              layout.right <= size[0] + 1 &&
              layout.heading > 180 &&
              layout.top >= 0,
            JSON.stringify({ preset, style, scale, size, layout }),
          );
          checks.push({ preset, style, scale, size, pass: true });
        }
  await apply(page, { preset: "alpine", style: "flat", scale: 100 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("选择壁纸文件").setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid"),
  });
  await page.getByRole("alert").filter({ hasText: "图片无法读取" }).waitFor();
  await page
    .getByLabel("选择壁纸文件")
    .setInputFiles(path.resolve("public/icon.png"));
  await page.waitForFunction(
    (key) => JSON.parse(localStorage.getItem(key)).wallpaper === "custom",
    key,
  );
  const prefs = await page.evaluate((key) => localStorage.getItem(key), key);
  await page.reload();
  await page.waitForSelector(".welcome");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    prefs,
  );
  await page.getByRole("button", { name: "设置与外观", exact: true }).click();
  await page.evaluate(() => {
    window.originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      throw new DOMException("fixture quota", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "110%", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "无法保存外观设置" })
    .waitFor();
  await page.evaluate(() => (Storage.prototype.setItem = window.originalSet));
  await apply(page, {
    preset: "alpine",
    style: "flat",
    scale: 100,
    wallpaper: "preset",
    customWallpaper: "",
    customWallpaperName: "",
    lowPerformance: true,
  });
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--theme-glass-blur",
      ),
    ),
    "0px",
  );
  await apply(page, { lowPerformance: false });
  await page.evaluate((key) => localStorage.setItem(key, "{damaged"), key);
  await page.reload();
  await page.waitForSelector(".welcome");
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "alpine",
  );
  return {
    matrix: checks,
    wallpaperImport: true,
    invalidImageRejected: true,
    reloadPersistence: true,
    storageFailureVisible: true,
    lowPerformance: true,
    damagedConfigFallback: true,
  };
};
