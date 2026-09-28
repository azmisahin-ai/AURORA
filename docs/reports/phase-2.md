# Phase 2 Report — Tool System + Permissions

Date: 2026-09-28

## Yapılanlar

- **Tool abstraction:** `Tool` arayüzü (`src/tools/types.ts`). Girdi şeması
  olarak **zod** kullanıldı; tek kaynak hem modele sunulan JSON Schema
  (`z.toJSONSchema`) hem de çalıştırma öncesi argüman doğrulaması.
- **ToolRegistry:** `src/tools/ToolRegistry.ts`. Faz 1'de tanımlanan
  `ToolExecutor` portunu implement eder, böylece `core` hiçbir tool import
  etmez (ADR 001). İzin kapısı, şema doğrulaması, hata→gözlem dönüşümü burada.
- **PermissionManager:** `READ_ONLY`, `WORKSPACE_WRITE`, `COMMAND_EXECUTION`,
  `NETWORK_ACCESS`, `FULL_ACCESS`. `FULL_ACCESS` diğerlerini kapsar.
  `NETWORK_ACCESS` bilinçli olarak verilmez — Faz 3'te URL doğrulamasıyla
  gelecek (ADR 004).
- **PathValidator:** workspace köklerine hapsetme. İki ayrı tehdit:
  (1) sözlü traversal (`../../etc/passwd`), (2) **symlink kaçışı** — sözlü
  olarak kök içinde görünüp `realpath` ile dışarı çıkan yol. `resolveReal`
  en derin var olan atayı çözümleyip tekrar containment kontrolü yapar.
- **CommandValidator:** allowlist/denylist + yapısal kontrol. Kabuk
  metakarakterleri (`; | > < ` $ ( ) { } [ ] \` ve newline) reddedilir;
  `sudo`, `sh`, `bash` vb. allowlist'te olsa bile **asla** çalışmaz.
- **ExecutionProvider / LocalExecutionProvider:** `spawn` + `shell: false`,
  minimal ortam (PATH/HOME/LANG/TERM/TMPDIR — API anahtarları miras alınmaz),
  süreç grubu + timeout'ta SIGKILL.
- **İlk tool'lar:** `read_file`, `write_file`, `list_files`, `run_command`.
- **Loop entegrasyonu:** `AgentLoop` artık izinli tool tanımlarını modele
  sunuyor (`ToolExecutor.definitions?()`), böylece model gerçekten tool
  çağırabiliyor.
- **Runtime wiring:** `buildToolRegistry()` (`src/tools/index.ts`);
  `AgentRuntime` varsayılan olarak tool'larla kurulur. Model seçimi hâlâ
  tamamen konfigürasyondan gelir (`AURORA_MODEL`) — mimariye gömülü değil.

## Değişen Dosyalar

- `src/tools/types.ts` — `Tool`, `ToolContext`, `defineTool`
- `src/tools/ToolRegistry.ts` — registry + izin kapısı + doğrulama
- `src/tools/index.ts` — `buildToolRegistry`, varsayılan izin seti
- `src/tools/filesystem/ReadFileTool.ts`, `WriteFileTool.ts`, `ListFilesTool.ts`
- `src/tools/execution/RunCommandTool.ts`
- `src/security/PermissionManager.ts`, `PathValidator.ts`, `CommandValidator.ts`,
  `index.ts`
- `src/providers/execution/ExecutionProvider.ts`, `LocalExecutionProvider.ts`
- `src/core/agent/types.ts` — `ToolExecutor.definitions?()` eklendi
- `src/core/agent/AgentLoop.ts` — modele tool tanımları sunuluyor
- `src/core/agent/AgentRuntime.ts` — tool registry varsayılan wiring
- Testler: `tests/unit/security/{permission-manager,path-validator,command-validator}.test.ts`,
  `tests/unit/tools/tool-registry.test.ts`,
  `tests/integration/permissions.test.ts`,
  `tests/integration/tool-use-live.test.ts`

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/security/permission-manager.test.ts` (7) | PASS | FULL_ACCESS kapsaması, eksik izin raporu |
| `tests/unit/security/path-validator.test.ts` (15) | PASS | traversal, symlink kaçışı, NUL, `..hidden` |
| `tests/unit/security/command-validator.test.ts` (22) | PASS | metakarakterler, allow/deny, tokenizer |
| `tests/unit/tools/tool-registry.test.ts` (21) | PASS | izin kapısı, şema doğrulama, fs round-trip |
| `tests/integration/permissions.test.ts` (5) | PASS | reddin **log'a** yazıldığı gerçek pino ile doğrulandı |
| `tests/integration/tool-use-live.test.ts` (1) | PASS | **gerçek** Ollama + `qwen3.5:4b`, dosya diskte doğrulandı |
| `tests/integration/ollama-live.test.ts` (1) | PASS | regresyon yok |
| Tüm birim testler (110) | PASS | 9 dosya |
| **Tam suite** | **PASS** | 12 dosya, **117 test**, 0 skip, ~98s |

Komut: `AURORA_MODEL=qwen3.5:4b npm test`

## Doğrulama Notları

- **Testin bulduğu gerçek hata:** `isContained` başlangıçta
  `rel.startsWith("..")` kullanıyordu; bu `..hidden/file` gibi meşru bir dosya
  adını yanlışlıkla reddediyordu. `rel !== ".." && !rel.startsWith(".." + sep)`
  ile düzeltildi. Bu, testin koda değil gerçek davranışa yazıldığının kanıtı.
- **Secret sızıntısı testi:** `AURORA_TEST_SECRET_SENTINEL` ana süreçte set
  edilip `node probe.mjs` ile çocuk süreçte okunmaya çalışıldı → `ABSENT`.
  Minimal ortam politikası doğrulandı.
- **Kabuk metakarakteri testi:** `node -e "...process.env..."` çağrısı
  validator tarafından (haklı olarak) reddedildi; test bu yüzden script dosyası
  kullanır hale getirildi. Yani kısıtlama gerçekten çalışıyor.

## Kullanılan Kaynaklar

- `docs/research/security.md` (Microsoft Learn indirect prompt injection,
  OWASP, Chrome for Developers) — defense-in-depth ilkeleri.
- `docs/research/agent-architectures.md` — tool-use döngüsü, harici doğrulama.
- `docs/adr/004-security-and-permissions.md` — izin modeli kararları.
- Node.js resmi `child_process.spawn` dokümanı (`shell`, `detached`, sinyal).
- zod v4 `toJSONSchema` — kurulu `zod@3.25.76` içindeki `zod/v4` alt yolu
  (yerel olarak doğrulandı: `node -e "require('zod/v4')"`).

## Alınan Kararlar

- **Girdi şeması tek kaynak:** zod. Modele sunulan JSON Schema ile çalıştırma
  öncesi doğrulama aynı tanımdan türetilir; ikisinin ayrışması imkânsız.
- **`shell: false` + metakarakter reddi:** İkisi birlikte. Biri diğerinin
  yerine geçmez; metakarakter reddi ayrıca audit log'unu belirsizlikten korur.
- **Deny, sonra bilgilendir:** İzinsiz tool çağrısı modele "kullanılamaz"
  olarak döner, böylece model uyum sağlayabilir; ama kapıyı geçemez.
- **Hata → gözlem:** Tool hatası varsayılan olarak fatal değil; koşuyu
  durdurmaz, modele geri beslenir. Yalnızca tool `fatal: true` derse durur.
- **`NETWORK_ACCESS` Faz 3'e ertelendi:** SSRF koruması (UrlValidator) hazır
  olmadan ağ erişimi verilmiyor.

## Varsayımlar

- **DOĞRULANACAK:** `list_files` varsayılan olarak `node_modules`, `.git`,
  `dist`, `coverage`, `.cache` atlar. Bu bir varsayım; kullanıcı bunları
  listelemek isterse parametre gerekir.
- **DOĞRULANACAK:** Timeout'ta `SIGKILL` tüm süreç grubuna gönderilir. POSIX
  dışı platformlarda `child.kill()`'e düşer.
- CPU-only ortamda `qwen3.5:4b` ilk yükleme ~60–110s; testler warm-up yapar.

## Kalan Problemler

- `run_command` çıktısı modele ham gönderiliyor; Faz 3'te untrusted veri
  sarmalama (nonce'lu delimiter) ve token limiti burada da uygulanmalı.
- `read_file`/`list_files` çıktıları da güvenilmeyen veri; sarmalama Faz 3'ün
  kapsamında.
- Rate limiting henüz yok (Faz 8).
- `run_tests` tool'u Faz 4'te (ExecutionProvider hazır, tool sarmalayıcısı
  yeterli).

## Sonraki Faz İçin Notlar

- **Faz 3 (Web Research + Knowledge):** `UrlValidator` ile SSRF koruması
  (`file://`, `localhost`, `169.254.169.254` reddi), `NETWORK_ACCESS` iznini
  açar. `Fetcher`/`SearchProvider` arayüzleri ve `NoopSearchProvider`.
  `KnowledgeStore` + metadata; web içeriği `UNTRUSTED DATA` olarak nonce'lu
  delimiter'larla sarılır. Tool çıktıları için token limiti.
- **Ortam notu:** Konteyner `$HOME` oturumlar arasında sıfırlanıyor;
  `/workspace` kalıcı. Ollama bu yüzden `/workspace/.tools/ollama` altına
  kuruldu, modeller `/workspace/.ollama-models` altında. `AGENTS.md`'ye
  yazıldı.
