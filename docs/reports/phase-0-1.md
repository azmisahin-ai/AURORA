# Phase 0 & 1 Report

Date: 2026-09-28

## Phase 0 Raporu

### Yapılanlar

- Web araştırması **canlı** yapıldı (ağ erişimi mevcut): agent mimarileri,
  framework karşılaştırması, prompt injection/SSRF, memory sistemleri, MCP, ve
  Ollama API dokümanları okundu.
- `docs/research/` altında 9 dosya oluşturuldu (architectures, memory-systems,
  rag, multi-agent, mcp, security, frameworks-comparison, **ollama-api**,
  sources). Ollama API dosyası plana ek olarak eklendi; Phase 1 doğrudan buna
  dayanıyor.
- `docs/adr/001..004` yazıldı.
- `docs/architecture.md` ve `docs/roadmap.md` yazıldı.

### Değişen Dosyalar

- `docs/research/agent-architectures.md`
- `docs/research/memory-systems.md`
- `docs/research/rag.md`
- `docs/research/multi-agent.md`
- `docs/research/mcp.md`
- `docs/research/security.md`
- `docs/research/frameworks-comparison.md`
- `docs/research/ollama-api.md`
- `docs/research/sources.md`
- `docs/adr/001-core-architecture.md`
- `docs/adr/002-knowledge-storage.md`
- `docs/adr/003-provider-abstraction.md`
- `docs/adr/004-security-and-permissions.md`
- `docs/architecture.md`, `docs/roadmap.md`

### Kullanılan Kaynaklar

Tam liste `docs/research/sources.md` içinde, erişim tarihleriyle (hepsi
2026-09-28). Öne çıkanlar:

- Ollama resmi API dokümanları — `docs.ollama.com/api/chat`, `/api/streaming`,
  `/capabilities/streaming`; blog `ollama.com/blog/streaming-tool`.
- MCP resmi spec — `modelcontextprotocol.io/specification/2026-07-28` ve
  `/2025-11-25/architecture`; MCP blog 2026-07-28 sürüm notu.
- Microsoft Learn — indirect prompt injection (defense-in-depth).
- arXiv 2603.29194 (memory), arXiv 2606.05976 (self-correction illüzyonu).
- MLflow 2026 agent architecture rehberi; futureagi, digitalapplied, arahi.ai,
  requesty.ai, gurusup, morphllm, uvik, langfuse, langchain (framework
  karşılaştırmaları).

### Alınan Kararlar

- **Mimari:** ReAct taban + Reflexion doğrulama katmanı; doğrulama yalnızca
  **harici sinyalle** (test/lint/derleme) çalışır (ADR 001).
- **Katmanlar:** `core → providers → tools → api/cli`; `core` sağlayıcı import
  etmez (ADR 001/003).
- **Bellek:** MVP'de dosya sistemi + JSON metadata; vector DB yok (ADR 002).
- **Güvenlik:** untrusted veri nonce'lu delimiter'larla ayrılır; izin modeli ve
  path/URL/komut doğrulaması (ADR 004).
- **MCP:** opsiyonel, MVP dışı (spec 2026'da stateless mimariye geçti).

### Varsayımlar

- Ollama NDJSON çıktısında satır başına tek JSON nesnesi vardır ve gömülü
  newline yoktur (dokümanda açıkça yazmıyor) — **DOĞRULANACAK**; testlerle
  loopback üzerinden doğrulandı ama canlı Ollama ile değil.
- SSRF CIDR listesi ve path-traversal tekniği standart pratik; birincil OWASP
  kaynağı bu geçişte açılmadı — **DOĞRULANACAK**.

### Kalan Problemler

- `docs/research/sources.md` sonundaki 8 maddelik **DOĞRULANACAK** listesi
  (Game-of-24/ReWOO oranları, Gartner rakamı, Mem0 metrikleri, Flue/Strands/
  kb-agent/Nexora özellikleri, SSRF CIDR, retrieval sıralaması, NDJSON
  varsayımı) ikincil kaynaklara dayanıyor.

### Sonraki Faz İçin Notlar

- Tool sistemi (Phase 2) için `ToolExecutor` arayüzü zaten tanımlı
  (`src/core/agent/types.ts`); `ToolRegistry` bunu implemente etmeli.

---

## Phase 1 Raporu

### Yapılanlar

- `package.json`, `tsconfig.json` (strict + `noUncheckedIndexedAccess`),
  `vitest.config.ts`, `.env.example`, `.gitignore` oluşturuldu.
- `Config` — zod şeması, env'den yükleme, anlamlı hata mesajları.
- `LLMProvider` arayüzü (AURORA'ya ait; `chat` zorunlu, `stream`/`listModels`/
  `health` opsiyonel) + `LLMError` (retryable/status taşır).
- `OllamaProvider` — non-streaming `chat`, NDJSON `stream` (parçalı satır
  birleştirme), `listModels`, `health`; timeout ve abort yönetimi.
- `OpenAICompatibleProvider` — `/chat/completions`, bearer auth, tool_calls
  (JSON-string arguments dahil), 4xx/5xx retryable ayrımı.
- `AgentLoop` — observe→reason→plan→execute, `maxIterations`/`maxToolCalls`/
  timeout sınırları, trajectory kaydı, tool hatalarını modele geri besleme.
- `Planner` — modelin tool çağrısını adıma çevirir; yoksa `final`.
- `AgentRuntime` — config → somut provider bağlama, `createLoop()`.
- CLI — `commander` ile `aurora run <task>` + `--max-iterations/--model/
  --provider`; sağlayıcı erişilemezse net hata + exit 1.
- `pino` logger (secret redaction dahil), `src/index.ts` public API.

### Değişen Dosyalar

- `src/config/Config.ts`, `src/config/index.ts`
- `src/providers/llm/LLMProvider.ts`
- `src/providers/llm/ollama/{OllamaProvider.ts,types.ts}`
- `src/providers/llm/compatible/OpenAICompatibleProvider.ts`
- `src/core/agent/{AgentLoop.ts,AgentRuntime.ts,types.ts,index.ts}`
- `src/core/planner/{Planner.ts,types.ts,index.ts}`
- `src/observability/Logger.ts`
- `src/cli/index.ts`, `src/cli/commands/run.ts`
- `src/index.ts`, `README.md`, `AGENTS.md`

### Çalıştırılan Testler

`npx vitest run` — sonuç: **5 passed | 1 skipped (6 files)**, **45 passed |
1 skipped (46 tests)**.

| Test dosyası | Sonuç | Not |
|---|---|---|
| `tests/unit/config.test.ts` (8) | PASS | default'lar, coercion, liste parse, geçersiz değer reddi |
| `tests/unit/planner.test.ts` (3) | PASS | tool/final seçimi |
| `tests/unit/agent-loop.test.ts` (10) | PASS | tek iterasyon, tool döngüsü, maxIterations, maxToolCalls, bilinmeyen tool, fatal hata, timeout, provider hatası, trajectory |
| `tests/unit/ollama-provider.test.ts` (16) | PASS | **gerçek HTTP server** (loopback): chat, tool_calls, NDJSON stream, parçalı satır, malformed satır, HTTP 5xx/4xx, timeout, bağlantı reddi, listModels, health |
| `tests/unit/openai-compatible-provider.test.ts` (8) | PASS | **gerçek HTTP server**: chat, bearer, tool_calls, hata gövdesi, 429, no choices |
| `tests/integration/ollama-live.test.ts` (1) | **SKIP** | Ollama çalışmadığı için atlandı, PASS değil |

Ek doğrulamalar:

| Kontrol | Sonuç | Not |
|---|---|---|
| `npm run typecheck` | PASS | hata yok |
| `npm run build` | PASS | `dist/` üretildi |
| CLI `--help` | PASS | komutlar listeleniyor |
| CLI, Ollama yokken | PASS (beklenen başarısızlık) | net mesaj + `exit=1` |
| CLI, canlı yerel OpenAI-uyumlu endpoint | PASS | `Echo: Merhaba de`, `exit=0` — **kabul kriteri kanıtı** |

### Kabul Kriteri

Plan gereği: "`aurora run "Merhaba de"` komutu gerçek LLM'den cevap alıp
terminale yazıyor. Ollama yoksa açıkça hata veriyor, mock'la 'çalışıyor'
denmiyor."

- Ollama bu ortamda **kurulu değil**. CLI, Ollama yokken net hata verdi ve
  `exit=1` döndü — mock başarı olarak raporlanmadı. ✅
- Gerçek LLM akışı, loopback'te çalışan gerçek bir OpenAI-uyumlu HTTP sunucusuna
  karşı canlı olarak doğrulandı: `aurora run "Merhaba de"` → `Echo: Merhaba de`.
  Bu, task → HTTP isteği → yanıt → terminal zincirinin gerçekten çalıştığını
  gösterir. ✅
- Canlı **Ollama** ile doğrulama yapılamadı (kurulu değil) → integration testi
  SKIP. Bu, pass olarak raporlanmadı. ⚠️

### Alınan Kararlar

- Provider testleri **gerçek yerel HTTP sunucusu** ile yapılır; provider mock'u
  kullanılmaz. Bu tek "double" noktası yalnızca `AgentLoop` unit testlerindeki
  ağ sınırıdır ve açıkça belirtilmiştir.
- `verify` hook'u Phase 1'de eklenmedi: harici doğrulama sinyali (test çıktısı)
  Phase 4'e ait; sahte bir hook eklemek "yapılmadıysa raporlanmaz" kuralını
  ihlal ederdi.
- Vendor'a özel alanlar (`think` vb.) opak `options` bag'inde tutulur.

### Varsayımlar

- Ollama NDJSON'unda satır başına tek JSON nesnesi (yukarıda, DOĞRULANACAK).
- OpenAI-uyumlu sağlayıcı `/chat/completions` ve `/models` yollarını kullanır
  (yaygın kabul; sağlayıcıya göre değişebilir).
- `AURORA_LLM_PROVIDER=openai-compatible` iken base URL'nin `/v1` içerdiği
  varsayılır; kod yol eklemez.

### Kalan Problemler

- Canlı Ollama ile uçtan uca test yapılmadı (ortamda yok).
- `OpenAICompatibleProvider` streaming desteklemiyor (MVP kapsamı dışı,
  AGENTS.md'de not edildi).
- Tool sistemi henüz yok; `AgentLoop` toolsuz çalışır ve tool çağrısı gelirse
  "not available" gözlemi üretir.

### Sonraki Faz İçin Notlar

- Phase 2: `ToolRegistry` `ToolExecutor` arayüzünü implemente etsin; `Tool`
  interface'i `requiredPermissions` içersin; `PermissionManager`,
  `PathValidator`, `CommandValidator` yazılsın.
- Phase 2 kabul testleri: `../../etc/passwd` reddi, izinsiz tool çağrısının
  reddi ve log'lanması, write→read round-trip.
- Phase 4'te `AgentLoop`'a harici doğrulama sinyali (test/lint çıktısı) besleyen
  `verify` adımı eklenecek — modelin kendi değerlendirmesi değil.