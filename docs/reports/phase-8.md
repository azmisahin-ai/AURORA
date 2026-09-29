# Phase 8 Report — Security Hardening

Date: 2026-09-28

## Yapılanlar

Phase 8 kontrol listesinin dört boşluğu kapatıldı. Zaten var olan ve test
edilen kontroller (path traversal, SSRF, komut allowlist, UNTRUSTED sarma,
permission modeli, timeout, fetch boyut sınırı) **yeniden yazılmadı**.

- **`SecretRedactor` (`security/SecretRedactor.ts`):** Kimlik bilgisini *şekle*
  göre yakalar — OpenAI `sk-…`, Anthropic `sk-ant-…`, GitHub `ghp_…`/
  `github_pat_…`, AWS `AKIA…`, Slack `xox…`, Google `AIza…` (35 karakter),
  Stripe `sk_live_…`, JWT, `Bearer` token, PEM private-key bloğu ve
  `scheme://user:password@host` URL'leri. Boolean döndüren katı desenlerin yanına
  tek gevşek desen (`password = …`) `looksLikeSecret` ile süzülür: değer harf+rakam
  karışık olmalı, ≥ 20 karakter olmalı ya da yoğun opak bir blob olmalı. Böylece
  `"the secret sauce: deliciousness"` değişmeden geçer; `api_key = "a1b2…"`
  redakte edilir. Yanlış-pozitif korpusu bir **test**, bir yorum değil.
  - `redactValue` döngüsel nesnelerde `[Circular]` döndürür ve `Error`
    nesnesini olduğu gibi bırakır. Paylaşılan global regex'ler her çağrıda
    `lastIndex` sıfırlanarak kullanılır (ikinci çağrının sızması imkânsız).
- **`ConfirmationGate` (`security/ConfirmationGate.ts`):** Üç değerli sonuç —
  `approved | denied | unavailable`. `denied` ile `unavailable`'ı tek bir
  `false`'a indirmek, gözetimsiz bir CI koşusunu kullanıcının "hayır"ından
  ayırt edilemez yapardı: ilki politikası gereği devam etmeli, ikincisi durmalı.
  - `AllowAllGate` (varsayılan, `confirmMode=allow`), `DenyAllGate`
    (`confirmMode=deny`), `PromptGate` (enjekte edilen `ask` fonksiyonu → TTY'siz
    test edilebilir; "evet" dışındaki her yanıt "hayır"dır).
  - `ToolRegistry`, bir tool'u `mutatesWorkspace === true` **veya**
    `COMMAND_EXECUTION` gerektirdiğinde kapıya tabi tutar. İkinci koşul önemli:
    kabuk komutu, workspace mutasyonu bildirmese bile makineyi değiştirebilir.
- **`RateLimiter` / `KeyedRateLimiter` (`security/RateLimiter.ts`):** Token
  kovası; **network** tool'ları sınırlar. Tehdit, bir sayfayı çekip parse
  edemeyen ve altmış kez yeniden çeken bir modeldir. Anahtar başına kova, geveze
  bir dosya tool'unun ağ bütçesini açlığa düşürmesini engeller. Saat **enjekte
  edilir**: `Date.now()` olsaydı testlerin tek ilginç kısmı (token'ın geri
  gelmesi) kaçınılmaz bir `sleep` olurdu. Red cezası exception değil, gözlemdir:
  döngü kurtarılabilir kalmalı ve mesaj modelin ihtiyaç duyduğu sinyaldir.
- **Argüman boyut sınırı:** `maxArgumentBytes` (varsayılan 64 KiB), şema
  doğrulamasından hemen sonra uygulanır. Bir dosyayı tool çağrısına yapıştıran
  model bir context-flooding denemesidir; sınır her tool'da değil kapıda daha
  ucuzdur. Kapıya (confirmation) **önce** uygulanır, yani dev bir yük hiçbir
  zaman terminale ulaşmaz.
- **Kablolama:** `buildToolRegistry`, config'ten somut gate/redactor/limiter
  üretir; her biri bir `opts.*` ile ezilebilir. `Logger`, pino `logMethod`
  kancasıyla redakte eder; yol-bazlı pino `redact` listesi korunur (iki katman
  tamamlayıcıdır). `ToolRegistry`, kapı sormadan önce argümanları redakte eder ve
  özeti **redakte edilmiş** argümanlardan kurar — böylece bir özet, argümanların
  temizlendiği bir sırrı sızdıramaz.
- **CLI:** `run` komutuna `--confirm`, `--no-confirm`, `--confirm-strict`
  eklendi. `prompt` modu kütüphane bağlamında güvenli varsayılana sahip olamaz
  (stdin yok); bu yüzden `PromptGate`'i yalnızca CLI kurar, kütüphane
  `DenyAllGate` ile kapalı yönde başarısız olur.
- **Config:** `redactLogs`, `maxArgumentBytes`, `toolRateLimit`,
  `toolRateRefill`, `confirmMode`, `confirmStrict`. Yinelenen/TDZ
  `booleanFromString` düzeltildi: `z.coerce.boolean()` `"false"` dizesini `true`
  yapardı; regresyon testi eklendi.

## Kapsam kararı — redaction nerede durur

Web içeriği ve dosya içerikleri modele gitmeden **önce redakte edilmez**.
Redakte etmek agent'ın meşru işini bozardı: bir config fixture'ı, bir test
vektörü ya da anahtar sözü geçen bir dokümanı okumak. AURORA'nın iddia ettiği
sınır: *operatör-görünür yüzeyler* (log'lar, confirmation soruları, denetim
metni) redakte edilir. Model context'ine sırrın girmesini engelleme iddiası
**yoktur**. Bu sınır ADR 010'da açıkça yazıldı ki gelecekteki bir faz onu
bilerek genişletebilsin.

## Değişen Dosyalar

- `src/security/SecretRedactor.ts` (yeni) — şekil + atama redaksiyonu,
  `redactValue`, `hasSecret`, `disabledKinds`.
- `src/security/ConfirmationGate.ts` (yeni) — üç değerli arayüz ve üç gate.
- `src/security/RateLimiter.ts` (yeni) — `RateLimiter`, `KeyedRateLimiter`.
- `src/security/index.ts` — yeni export'lar.
- `src/tools/ToolRegistry.ts` — boyut sınırı, rate limit, kapı, redakte özet;
  `summarizeCall`.
- `src/tools/index.ts` — gate/redactor/limiter kablolaması; `defaultConfirmationGate`;
  `rateLimiter` override'ı.
- `src/config/Config.ts` — Phase 8 alanları, `booleanFromString` düzeltmesi.
- `src/observability/Logger.ts` — redactor kancası.
- `src/cli/commands/run.ts` — `buildConfirmationGate`, üç bayrak.
- `src/core/agent/AgentRuntime.ts` — `RuntimeOptions.confirmationGate`.
- `src/index.ts` — güvenlik export'ları.
- `.env.example` — Phase 8 değişkenleri.
- `docs/adr/010-security-hardening.md` (yeni).
- `tests/unit/security/{secret-redactor,confirmation-gate,rate-limiter}.test.ts` (yeni).
- `tests/unit/tools/{tool-registry-hardening,build-tool-registry}.test.ts` (yeni).
- `tests/unit/observability/logger-redaction.test.ts` (yeni).
- `tests/integration/security-hardening.test.ts` (yeni).
- `tests/unit/{config,cli}.test.ts` — Phase 8 alanları ve bayrakları.

### İnceleme sırasında bulunan iki gerçek hata

Rapor yazılırken CLI'daki gate eşlemesi yeniden okunurken iki hata bulundu ve
düzeltildi. İkisi de test edilmemiş bir kod yolundaydı — tam da kabul kriterinin
"test edilmemiş başarı yoktur" kuralının hedeflediği durum.

1. **`deny` modu sessizce `allow` oluyordu.** `buildConfirmationGate`, `prompt`
   dışındaki her modu `AllowAllGate`'e düşürüyordu. Sonuç: `AURORA_CONFIRM_MODE=deny`
   ayarlayan bir operatör (veya CI) aslında "her şeyi onayla" elde ediyordu —
   güvenlik açısından sessiz, yüksek etkili bir hata. Eşleme artık modu birebir
   kendi gate'ine götürüyor ve bunu sabitleyen bir test var; eski kısayol geri
   gelirse test kırmızı.
2. **`PromptGate` ikinci soruda kırılıyordu.** `readline` arayüzü ilk cevaptan
   sonra kapatılıyordu ama gate her state-changing çağrıda yeniden soruyor; ikinci
   çağrıda kapanmış bir arayüz kullanılıyordu. Artık her soru için yeni bir
   `readline` kurulup cevaptan sonra kapatılıyor.

İkisi de `tests/unit/cli.test.ts` § "CLI confirmation gate mapping" ile
kapsandı; birinci hatanın koruyucu testi mutasyonla doğrulandı (kısayol geri
konunca 1 test FAIL).

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/security/secret-redactor.test.ts` (31) | PASS | Şekiller, atamalar, yanlış-pozitif korpusu, `disabledKinds`, döngü |
| `tests/unit/security/confirmation-gate.test.ts` (7) | PASS | Üç sonuç, EOF→unavailable, soru içeriği |
| `tests/unit/security/rate-limiter.test.ts` (7) | PASS | Burst, red+`retryAfterMs`, refill, kapasite tavanı, enjekte saat |
| `tests/unit/tools/tool-registry-hardening.test.ts` (13) | PASS | Kapı onay/red/TTY-yok, okuma sormaz, boyut sınırı, rate limit |
| `tests/unit/tools/build-tool-registry.test.ts` (8) | PASS | **Kablolama:** config→cap/gate/redactor/limiter, her biri mutasyon-koruyucu |
| `tests/unit/observability/logger-redaction.test.ts` (2) | PASS | Gerçek pino çıktısında mesaj ve nesne redaksiyonu |
| `tests/integration/security-hardening.test.ts` (9) | PASS | **Gerçek** registry/validator/child process/HTTP/pino |
| `tests/unit/config.test.ts` (17) | PASS | Phase 8 varsayılanları, env eşleme, `"false"` regresyonu |
| `tests/unit/cli.test.ts` (11) | PASS | `--confirm/--no-confirm/--confirm-strict` + gate eşlemesi (deny ≠ allow) |
| **Tam suite (canlı hariç)** | **466 PASS, 0 FAIL, 0 SKIP** | 41 dosya |
| **Tam suite (canlı dahil)** | **483 PASS, 0 FAIL, 0 SKIP** | 48 dosya; gerçek Ollama koştu |

### Mutasyon testi

Testlerin gerçekten yakaladığını kanıtlamak için dört mutasyon denendi.

| Mutasyon | Sonuç |
|---|---|
| Argüman boyut sınırı devre dışı | 2 test FAIL |
| Kapı her zaman `approved` döndürdü | 1 test FAIL |
| `redactor` kablolaması kaldırıldı | **önce PASS → kapsam boşluğu** |
| Config limiter dalı `false` yapıldı | **önce PASS → kapsam boşluğu** |
| CLI `deny` kısayolu geri kondu | 1 test FAIL |

İlk iki mutasyon hemen yakalandı. Son iki mutasyon **yakalanmadı** ve bu, tam da
mutasyon testinin varlık sebebini gösterdi: `ToolRegistry` testleri kendi
registry'lerini kurduğu için, kontrolü hiç bağlamayan bir `buildToolRegistry`
değişikliği tüm testlerden geçiyordu. Var olan ama bağlanmayan bir kontrol,
kontrol değildir. `tests/unit/tools/build-tool-registry.test.ts` bu kablolamayı
doğrudan assert edecek şekilde eklendi; iki mutasyon da artık yakalanıyor ve her
ikisi için birer koruyucu test bırakıldı (config'ten türeyen kapasitenin 4. çağrıyı
reddetmesi; redaksiyonun varsayılan olarak log'a uygulanması). Son satırdaki
mutasyon, inceleme sırasında bulunan `deny→allow` hatasının koruyucu testidir.

### Ölçüm

Gerçek `SecretRedactor` ile bu makinede, yanlış-pozitif korpusu (8 sıradan
satır: kod yolu, `npm test`, sürüm numarası, HTTP durum satırı, hash, ISO
zaman damgası, e-posta) **hiçbiri** değiştirilmedi; buna karşılık on üç gerçek
kimlik-bilgisi şekli redakte edildi. Yanlış-pozitif oranı bu korpusta 0/8.

## Kullanılan Kaynaklar

- `docs/research/security.md` — defense-in-depth; prompt injection'ı "güvenilir
  talimat ile güvensiz veriyi yapısal olarak ayır" çerçevesi.
- `docs/adr/004-security-and-permissions.md` — zaten var olan kontroller ve
  "state değiştiren işlemlerde kullanıcı onayı (uygulanabilir olduğunda)"
  ifadesinin somutlaştırılması.
- `docs/adr/001-core-architecture.md` — modelin kendi çıktısına güvenilmez;
  harici sinyal. Kapı kararını gate'e taşımak bu ilkenin bir uzantısıdır.
- Node.js v24.21.0 — `shell: false` yürütme, `rename` atomikliği, pino
  `logMethod` kancası bu makinede doğrulandı.
- `docs/reports/phase-7.md` — Phase 7 rapor formatı ve zemin.

## Alınan Kararlar

- Kapı **üç değerlidir**; `unavailable` ≠ `denied` (ADR 010).
- Varsayılan `confirmMode=allow`: gözetimsiz koşu bir prompt'ta kilitlenmemeli;
  asıl kısıt permission + validator + allowlist'tir.
- Kapı, `mutatesWorkspace` **veya** `COMMAND_EXECUTION` gerektiren tool'ları
  kapsar.
- Redaksiyon **operatör-görünür yüzeylerle** sınırlı; model gözlemleri
  redakte edilmez (bilinçli, ADR 010'da yazılı).
- Rate limit **gözetimsiz döngüyü** sınırlar, kullanıcıyı değil; red bir
  gözlemdir, exception değil.
- Limiter yalnızca network tool'larına uygulanır; anahtar başına kova.
- Boyut sınırı kapıdan önce uygulanır.
- Kapı özeti redakte edilmiş argümanlardan kurulur.
- Yanlış-pozitif, yanlış-negatif kadar ciddi bir hatadır: operatör gürültüyü
  yok saymayı öğrenirse kontrol ölür.

## Varsayımlar

- Tek process, tek log akışı; gerçek bir log toplayıcı entegrasyonu yok.
- `AURORA_TOOL_RATE_LIMIT` varsayılanı 20, tek bir tool için makul bir burst —
  politika değil, güvenli bir varsayılan.
- `AURORA_MAX_ARGUMENT_BYTES` varsayılanı 64 KiB; gerçek dosya yazımlarının çok
  üstünde, context-flooding'in belirgin altında.
- Rate limiter süreç-içidir; çoklu process arasında paylaşılmaz.
- `confirmMode=prompt` yalnızca bir terminalde anlamlıdır.

## Kalan Problemler

- **Gözlem redaksiyonu DOĞRULANACAK:** seçici bir politika (ör. `run_command`
  gözlemini redakte, `read_file`'ı etme) makul ama tasarlanmadı; kötü
  yapılırsa tool kullanımını bozar.
- **Rate limiter kalıcı değil:** restart kovayı sıfırlar; uzun süreli bir
  görevde süreç yeniden başlarsa burst yeniden açılır. Kabul edildi.
- **Kapı kararı denetlenemez:** red/onay olayları loglanır ama ayrı bir denetim
  izi (audit trail) yok; Phase 9/10 trajectory bunu görünür kılabilir.
- **Secret şekilleri bakım gerektirir:** yeni bir sağlayıcı öneki eklendiğinde
  desen listesi güncellenmelidir; otomatik keşif yok.
- **Prompt injection hâlâ bir containment problemidir:** nonce'lu sarma ve
  etiketleme savunmadır, kanıt değil; model yine de veri içindeki bir talimatı
  izleyebilir. Sınır ADR 004'te olduğu gibi kalır.
- **Entropi tabanlı tespit yok:** yüksek-entropi ama tanınmayan bir anahtar
  (ör. bir iç servis token'ı) kaçar; bilinçli bir yanlış-pozitif dengesi.

## Sonraki Faz İçin Notlar

- Phase 9 (CLI + API): kütüphane bağlamında `prompt` modu güvenli varsayılana
  sahip olamaz; HTTP API de bir `ConfirmationGate` enjekte etmeli ve TTY'siz
  `PromptGate` kurmamalıdır.
- `ConfirmationGate`, `ToolRegistry` ve `AgentRuntime` boyunca zaten akan bir
  seam'dir; sunucu tarafı bir onay akışı (ör. bekleyen istek + `POST /confirm`)
  bu arayüzün arkasına takılabilir.
- Rate limiter ve argüman sınırı **gözlemlenebilir**; trajectory'de bir denial
  asla sessiz değil — Phase 10 UI panelinde gösterilebilir.
- `SecretRedactor` desen listesi, yeni sağlayıcılar için tek güncelleme
  noktasıdır.
- `FileKnowledgeStore`'un metadata'sı bir provenance zinciridir; gelecekteki bir
  RAG fazı, `verified` bayrağını retrieval filtresi olarak kullanabilir — bu
  Phase 7'den beri açık bir sorudur.

> Phase 8 kabul kriterleri (güvenlik kontrol listesi, her modül için edge case,
> zararlı komut/SSRF/prompt-injection entegrasyon redleri) karşılandı; Phase 9'a
> geçilebilir.
