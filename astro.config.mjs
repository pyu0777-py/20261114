import { defineConfig } from 'astro/config';

export default defineConfig({
  // ❌ 错误配置（会导致无限循环）
  // outDir: 'public',

  // ✅ 正确配置（推荐）
  outDir: 'dist', // 或你自定义的其他目录名，如 'build', 'output' 等
});
