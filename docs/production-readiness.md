# AURORA — Production Readiness

**Sorulan soru:** Proje tam olarak nerede kaldı, doğrudan production kullanımı
için hangi görevler kaldı?

**Değerlendirme tarihi:** 2026-09-29 · **Dal:** `feat/cap-004-event-visibility`

Bu belge bir *iddia* değil, ölçümdür. Aşağıdaki her satır ya bu oturumda
çalıştırılan bir komutla ya da koddan okunarak doğrulanmıştır. Doğrulanamayan
noktalar açıkça **DOĞRULANACAK** işaretlidir.

---

## 1. Tam olarak nerede kaldık

### Biten

| Ne | Durum | Kanıt |
|---|---|---|
| Faz 0–10 (runtime çekirdeği) | ✅ tamam | `docs/roadmap.md` kabul kriterleri |
| **M0** — capability visibility (CAP-004) | ✅ tamam | canlı timeline + SSE + `app.js` testi; 3 mutasyon yakalanıyor |
| Build | ✅ geçiyor | `npm run build` → exit 0 |
| Test paketi | ✅ 604 geçti, 5 skip | `Test Files 59 passed \| 5 skipped (64)` |
| Güvenlik açığı | ✅ 0 | `npm audit --omit=dev` → 0 vulnerabilities |
| CLI çalışıyor | ✅ | `node dist/cli/index.js --help` → 6 komut listeleniyor |
| Ölçek | 87 `src/*.ts` / ~9.678 satır · 64 test dosyası | `find`/`wc` |

### Devam eden

**M1 — Model-agnostic hardening & config truth.** Bu turda kapsam analiz edildi;
**henüz kod yazılmadı** (working tree temiz, M0 commit'i origin'in 1 önde).

### Bitmemiş / eksik olanlar

| Ne | Durum | Kanıt |
|---|---|---|
| CI (GitHub Actions) | ❌ **yok** | `.github/workflows` dizini mevcut değil |
| Dockerfile / imaj | ❌ yok | dosya yok |
| LICENSE | ❌ yok | `LICENSE*` bulunamadı |
| Release / git tag | ❌ yok | `git tag` boş; sürüm `0.1.0`, hiç tag'lenmemiş |
| MCP | ❌ kod yok | yalnızca `docs/research/mcp.md` |
| RAG / vektör arama | ❌ yok | keyword-only (`FileKnowledgeStore`) |
| Plan-Execute / ToT | ❌ yok | `Planner` ince: ilk tool çağrısı, yoksa final |
| Paralel alt-ajan | ❌ yok | sıralı devretme |
| API run kalıcılığı | ❌ yok | süreç belleği |
| Sandbox | ❌ yok | allowlist *kapı*, izolasyon değil |
| Eval suite | ❌ yok | regresyon kapısı yok |
| OpenAI-uyumlu streaming | ❌ yok | `stream?` implement edilmemiş |
| Metrikler (latency/token/verdict) | ❌ yok | yalnızca log |

---

## 2. Bu oturumda doğrulanan gerçekler

1. **Ollama bu host'ta KURULU DEĞİL.** `curl localhost:11434/api/tags` başarısız.
   Bu yüzden 5 canlı integration testi `SKIP` ediyor; suite "PASS" değil
   "skipped" diyor — dürüst davranış. Canlı doğrulama isteyen her iş önce Ollama
   varlığını kontrol etmeli.
2. **Provider başlangıç kapısı VAR.** `run`, `research`, `tasks run` komutları
   `llm.health()` çağırıp erişilemezse açık bir mesajla çıkıyor
   (`src/cli/commands/run.ts:70-80`). Yani "mock'u başarı gibi raporlama" riski
   kapılmış.
3. **AMA model doğrulaması YOK.** Varsayılan model `llama3.2`; host'ta çekili
   olup olmadığı başlangıçta kontrol edilmiyor. Sunucu ayakta ama model yoksa
   hata *run ortasında* gelir. Bu, `§13.3`'ün hâlâ açık olduğunu gösterir.
4. **`node:sqlite` yerleşik ve FTS5 + trigram destekli** (Node v24.21.0). M2
   sıfır yeni runtime bağımlılığıyla yapılabilir.
5. **`@modelcontextprotocol/sdk` 1.31.0** yayında (M4 için hazır).
6. **Runtime bağımlılığı 7 adet**, hepsi olgun: `cheerio, commander, pino,
   pino-pretty, turndown, undici, zod`.

---

## 3. Production için kalan işler — önem sırasına göre

Önem dereceleri: **P0** = herhangi bir production kullanımını engeller ·
**P1** = belirtilen hedefi (local-first workstation) engeller · **P2** = önemli,
ama engel değil.

### P0 — Bunlar olmadan "production" denemez

| # | İş | Neden P0 | Kabul kriteri |
|---|---|---|---|
| 1 | **CI yok** | Hiçbir push test koşmuyor. Bugün 604 test yeşil; yarın bozulsa kimse görmez. Tek bir yanlış commit sessizce master'a girer. | `push`/`PR`'da `npm run build` + `npm test` + `typecheck` koşan workflow; kırmızıysa merge edilemez |
| 2 | **Model doğrulaması yok** | Kutudan çıktığı gibi ilk çalıştırma, `llama3.2` çekili değilse run ortasında patlar. "Model-agnostic" iddiası kanıtsız kalıyor. | Başlangıçta model çekili mi kontrolü + eyleme dönük mesaj ("`ollama pull llama3.2` çalıştır") |
| 3 | **LICENSE yok** | Hukuken dağıtılamaz; "production kullanım" tanımı gereği engel. | Bir lisans dosyası + `package.json` `license` alanı |
| 4 | **Release/tag yok** | Sürüm `0.1.0` ama hiç tag yok; hangi commit'in ne olduğu izlenemez, geri dönülemez. | Annotated tag + değişiklik günlüğü; sürüm politikası |

### P1 — Belirtilen hedefin (local-first workstation) eksikleri

Bunlar `docs/roadmap.md` M2–M7'ye karşılık gelir; her birinin kabul kriteri
orada yazılı.

| # | İş | Milestone | Neden hedef için gerekli |
|---|---|---|---|
| 5 | **Eval suite** | M7 | Bugün "çalışıyor" bir *görüş*. Model değişince, kod değişince regresyonu yakalayacak sabit görev seti yok. **Production'ın en kritik eksiği budur.** |
| 6 | **MCP** | M4 | En büyük yapısal boşluk; ekosisteme erişim yok |
| 7 | **RAG (hybrid arama)** | M2 | Knowledge büyüdükçe keyword-only isabet düşer |
| 8 | **Plan-Execute + ToT** | M3 | Yapılandırılmış iş ve zor akıl yürütme için ReAct yanlış şekil |
| 9 | **Paralel alt-ajan + kalıcı API run'ları** | M5 | Kapasite kullanımı ve çökme dayanıklılığı |
| 10 | **Sandbox** | M6 | Allowlist izolasyon değil; kaçış senaryoları açık |
| 11 | **Metrikler** | M7 | Latency/token/verdict görünür değil, yalnızca log |

### P2 — İyileştirmeler

| # | İş | Milestone |
|---|---|---|
| 12 | OpenAI-uyumlu `stream()` | M1 |
| 13 | Gözlem redaksiyonu (sırlar modele ulaşmasın) | M6 |
| 14 | Kalan `DOĞRULANACAK` işaretleri (25+) | M7 |
| 15 | Docker imajı (opsiyonel; local-first hedefe şart değil) | — |

---

## 4. İki farklı bitiş çizgisi var — hangisini istediğine karar ver

Bu ayrım önemli, çünkü "production" iki farklı şey demek olabilir.

### Çizgi A — "Ben bugün güvenle kullanayım" (kısa yol)

Amaç: AURORA'yı kendi makinende, güvenle, tek kullanıcı olarak kullanmak.

Kalan iş: **P0'ın tamamı (1–4)** + **eval smoke (5)**.

Bu, mevcut çekirdeği değiştirmez; eksik olan *güvence ve paketleme*
katmanlarını ekler. Çekirdek zaten test edilmiş durumda.

### Çizgi B — "Belirtilen hedef: production-grade workstation" (uzun yol)

Amaç: çok mimarili, MCP'li, RAG'lı, paralel, izole, ölçülen bir workstation.

Kalan iş: **P0 + P1'in tamamı (M1–M7)**. `docs/roadmap.md` bunu zaten
tanımlıyor.

> Öneri: **Önce Çizgi A.** Sebep: A tamamlanınca elinde *güvenilir bir taban*
> olur (CI her commit'i korur, eval regresyonu yakalar, lisans/paketleme tamam).
> M2–M7 gibi büyük eklemeler o tabanın üstünde güvenle yapılır. Taban olmadan
> MCP/RAG eklemek, bozulduğunda fark edilmeyen bir sisteme katman eklemek olur.

---

## 5. Netleştirilmiş plan

### Sıra 1 — Tabanı sağlamlaştır (Çizgi A)

| Adım | İş | Kanıt |
|---|---|---|
| A1 | CI workflow: build + typecheck + test (Ollama yokken skip'ler dürüst kalır) | PR'da yeşil/kırmızı |
| A2 | Model doğrulaması: başlangıçta model çekili mi; eyleme dönük hata | test + elle |
| A3 | `aurora doctor`: provider erişimi, modeller, yetenek ipuçları | unit test |
| A4 | LICENSE + `package.json` license alanı | dosya |
| A5 | Eval smoke: 5–10 sabit görev, pass/fail, regresyon kapısı | eval raporu |
| A6 | Release: tag + changelog | `git tag` |

**A bittiğinde:** çekirdek her commit'te korunuyor, ilk kurulum çalışıyor,
yasal olarak dağıtılabilir, "çalışıyor" ölçülebilir.

### Sıra 2 — Hedef yetenekleri (Çizgi B, M1→M7)

`docs/roadmap.md`'deki sıra geçerli: M1 (streaming + config truth) → M2 (RAG) →
M3 (mimariler) → M4 (MCP) → M5 (paralel + kalıcı run) → M6 (izolasyon) → M7
(eval + metrikler).

Her milestone kendi kabul kriteriyle kapanır; hiçbiri test geçmeden "bitti"
sayılmaz.

---

## 6. Dürüst özet

AURORA'nın **motoru olgun**: 604 test geçiyor, güvenlik katmanları gerçek,
döngü/doğrulama/izin/bellek/kalıcılık çalışıyor ve her iddia testle
destekleniyor. Bu, "MVP çekirdeği tamam" demek.

Ama **production kullanımı için gereken güvence katmanı eksik**: CI yok (hiçbir
regresyon yakalanmıyor), lisans yok (dağıtılamaz), sürüm/tag yok (izlenemez),
model doğrulaması yok (ilk çalıştırma kırılgan) ve eval yok ("çalışıyor" bir
görüş).

**En kritik tek eksik: CI + eval.** Çünkü diğer her şeyin güvenilirliği buna
bağlı. Bir sistemi production'da tutan şey özellikleri değil, bozulduğunda
haberdar olmandır.

**Öneri:** Sıra 1'i (A1–A6) bitir; sonra M2–M7'ye geç. Böylece her yeni yetenek,
onu koruyan bir tabanın üstüne eklenir.
