# Phase 7 Report — Context Management + Memory

Date: 2026-09-28

## Yapılanlar

- **Üç bellek katmanı, ayrık ve biri zaten var (`core/memory/`):**
  Working (koşunun canlı transcript'i, bellekte), Session (konuşma başına
  dayanıklı kayıt, dosyada), Knowledge (Phase 3'ten, tool-güdümlü — **yeniden
  yazılmadı**). Knowledge katmanının kopyalanmaması bilinçli: araştırma,
  "hangi retrieval mekanizması" sorusunu açık bir soru olarak bırakıyor.
- **`InMemoryWorkingMemory` (`core/memory/WorkingMemory.ts`):** transcript'in
  tek sahibi; `messages()` kopya döndürür, iç tampon dışarıdan değiştirilemez.
- **`FileSessionStore` (`core/memory/SessionMemory.ts`):** konuşma başına
  `<dir>/<id>.json`. Yazma **atomiktir** (temp dosya + `rename`) — Phase 6'nın
  dersini birebir yineler. `SessionRecord` bir transcript değil, denetlenebilir
  bir özettir: görev, durum, kullanılan tool'lar, kısaltılmış cevap, sayaçlar.
  Tek process kapsamı, tıpkı `FileTaskStore` gibi (ADR 008).
- **`buildSessionRecall` (`core/memory/SessionRecall.ts`):** önceki oturumların
  sınırlı bir özetini kurar. İki karar:
  1. **Çıkarımsal (extractive), üretilmiş değil** — alanlardan deterministik
     olarak kurulur. Model-üretimi özet, doğrulanmamış iddiaları "bellek" gibi
     contexte sokardı (ADR 001). Model tabanlı özetleme **DOĞRULANACAK**.
  2. **UNTRUSTED olarak sarılır** — nonce'lu delimiter + boyut sınırı
     (`wrapUntrusted`, ADR 004).
- **`ContextBuilder` (`core/context/`):** her provider çağrısı için bütçeye
  uyan görünüm. Sıra, en ucuz ve en az kayıplıdan başlar:
  (1) bütçe içindeyse dokunma, (2) büyük tool gözlemlerini kısalt (baş+son,
  görünür işaret), (3) en eski **turları** ortadan çıkar (baş ve son korunur),
  (4) hâlâ sığmıyorsa `overBudget` diye **raporla** — görevi düşürme.
- **`HeuristicTokenEstimator`:** ~4 karakter/token, muhafazakâr (yukarı yuvarlar,
  mesaj başına ek yük ekler). Sağlayıcıdan bağımsız AURORA'nın evrensel bir
  tokenizer'ı yok; sayı yalnızca *ne zaman sıkıştıracağına* karar verir, asla
  katı bir API sınırı olarak kullanılmaz — bu yüzden etiketli bir sezgisel
  dürüsttür.
- **`AgentLoop` entegrasyonu:** tam transcript `messages`'ta kalır; her provider
  çağrısı `view()` üzerinden bütçeli görünümü alır. `ContextPort` arayüzü
  sayesinde `core/agent` somut builder'a bağımlı değildir (katman kuralı).
  Koşu, `context: { compactions, finalTokens, overBudget }` istatistiklerini
  raporlar; CLI sıkıştırmayı stderr'e yazar.
- **Korunan başlık (protected head):** baştaki `system`/`user` dizisi —
  sistem prompt'u, olası recall bloğu ve görev. **Dinamik olarak sayılır**,
  sabit değil: recall eklendiği anda sabit bir sayı (eski `protectedHead: 2`)
  görevi sessizce korumasız bırakırdı. Atlama bildirimi başlıktan *sonra*
  eklenir, sistem prompt'una asla — sistem prompt'u güven çapasıdır (ADR 004).
- **`AgentRuntime.runTask`:** önce `recall()`, sonra koşu, sonra oturum kaydı.
  `recall()` devre dışıysa veya saklı oturum yoksa `undefined` döner; yani ilk
  koşu Phase 7 öncesiyle birebir aynıdır. Oturum kaydı yazılamazsa koşu
  başarısız olmaz; hata loglanır, çıktı aynen döner.
- **Recall injection:** recall bloğu bir **user** mesajıdır, görevden *önce*
  gelir; böylece görev son talimat olarak kalır. Asla `system` mesajı değildir.
- **CLI (`cli/commands/sessions.ts`):** `sessions list | show | recall`.
  `run` komutuna `--recall-sessions`, `--no-recall`, `--context-budget` eklendi.
- **Config:** `AURORA_SESSION_DIR` (varsayılan `./sessions`),
  `AURORA_RECALL_SESSIONS` (varsayılan 3; 0 devre dışı). Bütçe için mevcut
  `AURORA_TOKEN_BUDGET` yeniden kullanıldı; yinelenen bir `contextBudget` alanı
  eklenmedi.

## Sıkıştırma ölçümü

Gerçek `ContextBuilder` ile bu makinede ölçüldü (4 KB gözlemler, 8 000 token
bütçe):

| tur | ham token | sınırlı token |
|---|---|---|
| 5 | 5 099 | 5 099 |
| 25 | 25 439 | 7 181 |
| 50 | 50 864 | 7 181 |
| 100 | 101 714 | 7 181 |
| 200 | 203 414 | 7 181 |

Ham geçmiş koşuyla doğrusal büyür; sınırlı görünüm bir platoda durur. 8 000
token bütçe, 200 turluk / 203 k token'lık bir transcript'i 7 181 token'da tuttu.

## Değişen Dosyalar

- `src/core/context/{types,ContextBuilder,TokenEstimator,index}.ts` (yeni) —
  bütçeli görünüm, eşik değerlendirici, türler.
- `src/core/memory/{types,WorkingMemory,SessionMemory,SessionRecall,index}.ts`
  (yeni) — üç katmanın Working/Session parçaları ve recall.
- `src/core/agent/types.ts` — `ContextPort`, `ContextStats`, `sessionRecall`;
  oturum türleri `context`'ten `memory`'ye taşındı.
- `src/core/agent/AgentLoop.ts` — bütçeli `view()`, recall injection, zaman aşımı
  bayrağı (aşağıda), `context` istatistikleri.
- `src/core/agent/AgentRuntime.ts` — `runTask`, `recall()`, `createLoop({sessionRecall})`,
  oturum kaydı; `createTaskExecutor` artık `runTask` üzerinden gider.
- `src/core/context/types.ts` — oturum türleri kaldırıldı (sahiplik `memory`'de).
- `src/config/Config.ts`, `.env.example` — `sessionDir`, `recallSessions`.
- `src/cli/commands/{run,sessions}.ts`, `src/cli/index.ts` — recall/bütçe
  seçenekleri ve `sessions` komutu.
- `src/index.ts` — yeni export'lar.
- `tests/unit/context/{context-builder,token-estimator}.test.ts` (yeni).
- `tests/unit/memory/{session-store,recall}.test.ts` (yeni).
- `tests/unit/agent-loop-context.test.ts` (yeni).
- `tests/integration/session-memory.test.ts` (yeni).
- `tests/integration/memory-live.test.ts` (yeni, canlı Ollama).
- `tests/unit/cli.test.ts` — `sessions` ve Phase 7 seçenekleri.

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/context/context-builder.test.ts` (10) | PASS | Bütçe, kısaltma, tur atlama, korunan başlık, `overBudget` |
| `tests/unit/context/token-estimator.test.ts` (7) | PASS | Monotonluk, muhafazakârlık, tool argümanlarını sayma |
| `tests/unit/memory/session-store.test.ts` (12) | PASS | Atomik yazma, restart, id güvenliği, bozuk kayıt, eşzamanlılık |
| `tests/unit/memory/recall.test.ts` (10) | PASS | UNTRUSTED sarma, sınırlar, tek satıra indirme |
| `tests/unit/agent-loop-context.test.ts` (6) | PASS | Sıkıştırma, korunan başlık, recall sırası, system-değil-user |
| `tests/integration/session-memory.test.ts` (5) | PASS | **Gerçek** restart + gerçek `AgentRuntime`/depo/builder |
| `tests/integration/memory-live.test.ts` (1) | PASS | **Gerçek** Ollama; koşu diske yazıldı, taze runtime okudu |
| `tests/unit/cli.test.ts` (8) | PASS | `sessions` alt komutları, `--recall/--no-recall/--context-budget` |
| **Tam suite** | **399 PASS, 0 FAIL, 0 SKIP** | 41 dosya; tüm canlı Ollama/internet testleri gerçekten koştu |

### Mutasyon testi

Testlerin gerçekten yakaladığını kanıtlamak için altı mutasyon denendi; altısı
da yakalandı:

| Mutasyon | Sonuç |
|---|---|
| `AgentLoop` `contextBuilder`'ı yok saydı | 1 test FAIL (sıkıştırma testi) |
| Dinamik korunan başlık → `return 0` | 5 test FAIL (görev/prompt korunmuyor) |
| Recall `user` → `system` mesajı | 2 test FAIL (UNTRUSTED/user testleri) |
| Gözlem kısaltması kaldırıldı | 1 test FAIL (kısaltma testi) |
| `safeId` doğrulaması kaldırıldı | 1 test FAIL (path traversal reddi) |
| Recall'da `wrapUntrusted` kaldırıldı | 9 test FAIL (UNTRUSTED testleri) |

### Flaky test düzeltmesi (kapsam dışı ama gerekli)

`tests/unit/agent-loop.test.ts > returns timeout when the provider is too slow`
ilk (soğuk) çalıştırmada aralıklı olarak başarısız oluyordu: zaman aşımı, duvar
saatiyle (`Date.now() >= deadline`) yeniden türetiliyordu ve `setTimeout` bir
milimetre önce patlayınca "timeout" yerine "aborted" raporlanıyordu. Zaman aşımı
artık bayrakla (`timedOut`) işaretleniyor; duvar saati karşılaştırması kaldırıldı.
Bu bir test harness düzeltmesi değil, gerçek bir doğruluk düzeltmesidir —
gerçek bir zaman aşımı yanlış etiketleniyordu.

## Kullanılan Kaynaklar

- `docs/research/memory-systems.md` — üç katmanlı hiyerarşi; "klasik diyalog
  geçmişi birleştirme bellek girişimi ve hesaplama verimsizliğine yol açar"
  (§2, Phase 7'nin varlık sebebi).
- `docs/adr/001-core-architecture.md` (harici sinyal; sınırlı döngü),
  ADR 002 (dosya sistemi deposu + arayüz; Knowledge katmanı),
  ADR 004 (UNTRUSTED sarma, nonce'lu delimiter),
  ADR 008 (atomik yazma dersi, tek-process kapsamı).
- Node.js v24.21.0 — `rename` atomikliği ve sıkıştırma ölçümleri bu makinede
  yapıldı.

## Alınan Kararlar

- Transcript tam tutulur; yalnızca provider çağrısı bütçelenir (ADR 009).
- Sıkıştırma sırası: gözlem kısalt → tur atla → `overBudget` bildir. Görev
  asla düşürülmez.
- Korunan başlık **dinamik sayılır**; sabit sayı recall eklendiğinde görevi
  korumasız bırakırdı.
- Bir tur bölünmez; `tool_calls` ile `tool` sonucu asla ayrılmaz (provider'lar
  reddeder).
- Oturum kaydı **çıkarımsaldır**, model-üretimi değil; UNTRUSTED sarılır ve
  `user` mesajı olarak enjekte edilir.
- Oturum kalıcılığı koşuyu asla başarısız etmez.
- Knowledge katmanı yeniden yazılmaz; tool-güdümlü `knowledge_search` kalır.
- Token sayımı etiketli bir sezgiseldir; katı API sınırı olarak kullanılmaz.

## Varsayımlar

- Tek process oturum dizinini kullanır; process'ler arası kilit yoktur (ADR 008
  ile aynı sınır).
- Recall için varsayılan 3 oturum makul bir üst sınırdır — politika değil,
  güvenli bir varsayılan.
- `AURORA_TOKEN_BUDGET` hem eski hem yeni bağlam yolu için tek bütçedir.

## Kalan Problemler

- **Model tabanlı oturum özetleme DOĞRULANACAK:** şu an çıkarımsal özet, uzun bir
  oturumun nüansını taşımaz; model özeti daha zengin ama doğrulanmamış olurdu.
  Karar bilinçli olarak ertelendi.
- **Retrieval mekanizması açık:** Knowledge her prompt'a enjekte edilmiyor;
  `knowledge_search` tool'una bağlı. Bu, araştırmanın açık bıraktığı sorudur
  (gömme tabanlı hybrid search adayı).
- **Halüsinasyona karşı koruma:** recall bloğu bir önceki koşunun cevabını
  taşır; o cevap yanlışsa yeni koşuya yanlış bilgi tohumlanır. UNTRUSTED sarma
  bunu bir *talimat* olarak yorumlanmaktan korur, ama *yanlış* olmaktan
  korumaz. "Doğrulanmış: true" bayrağı yalnızca kaynak provenance'ı içindir.
- **Sıkıştırma kaybı ölçülmedi:** hangi turların atılmasının cevap kalitesini
  ne kadar düşürdüğü ölçülmedi; bu bir kalite-ölçüm işidir, birim testi değil.
- `recover()` ve oturum taraması senkron tam tarama yapar; çok sayıda kayıtta
  indeks gerekebilir.

## Sonraki Faz İçin Notlar

- Phase 8 (Security Hardening) şu zeminin üzerine kurulur: UNTRUSTED sarma
  (ADR 004) artık recall üzerinden ikinci bir giriş noktasına sahip; secret
  redaction ve komut allowlist'i genişletilecek.
- `ContextPort`, farklı bir bütçeleme politikası (ör. plan-execute için özet
  tabanlı) takmak için hazır bir seam'dir.
- `SessionRecord`'a görevle ilişkili token maliyeti eklemek, Phase 6'nın
  "görev başına token muhasebesi" notunu kapatır.
- `KnowledgeStore` arayüzü, gömme tabanlı retrieval için doğal seam'dir.
