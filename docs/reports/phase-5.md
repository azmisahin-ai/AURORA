# Phase 5 Report — Sub-Agent System

Date: 2026-09-28

## Yapılanlar

- **Rol kataloğu (`core/agent/roles/`):** Beş rol — `researcher`, `coder`,
  `tester`, `reviewer`, `documenter`. Her rol bir sistem prompt'u, bir tool
  listesi, bir izin tavanı (`maxPermissions`) ve bir bütçe
  (`maxIterations`, `maxToolCalls`, `maxVerifications`) taşır. Rol seti
  `z.enum` ile sabittir; model yeni bir rol uyduramaz.
- **`SubAgentManager` (`core/agent/subagent/`):** Aynı process içinde, rol
  tabanlı `AgentLoop` instance'ı kurar. Mikroservis değil — MVP'nin değeri
  context izolasyonu ve least privilege; ikisi de process sınırında daha zor
  gözlenir, daha kolay değil (ADR 007).
- **Context izolasyonu:** Alt agent yalnızca **kendi rol prompt'unu ve
  verilen görevi** görür; ana konuşma geçmişini **hiç** almaz. Test bunu
  doğrudan doğrular: alt agent'ın ilk sağlayıcı çağrısı tam olarak iki mesaj
  içerir. Rol prompt'u ana prompt'u *genişletmez*, *değiştirir* — aksi halde
  iki agent tek büyük bağlama dönüşürdü.
- **Least privilege yapısaldır, runtime kontrolü değil:** Bir rolün tool
  seti, rolün listesi ile ana koşunun verdiği izinlerin **kesişimidir**;
  `FULL_ACCESS` asla yayılmaz. `roleToolsetBuilder.build` **yeni bir
  `ToolRegistry`** kurar; rolün listelediği ama karşılayamadığı tool
  *düşürülür*, sunulup sonra reddedilmez. Reviewer rolünün registry'sinde
  `write_file` hiç yoktur.
- **`delegate` tool'u (`tools/agent/DelegateTool.ts`):** Modelin alt agent
  bütçesini harcayabileceği tek yol, dolayısıyla delegasyon trajectory'de
  görünür. `delegate` **yalnızca ana registry'ye** kaydedilir; rol
  registry'leri onu içermeyen bir katalogdan kurulur. Alt agent'lar
  delega edemez — derinlik sayacıyla değil, **inşa gereği**. Erişilemeyen bir
  sınır yanlış ayarlanamaz.
- **Delege edilen düzenleme ana doğrulayıcıyı tetikler:** `ToolResult` ve
  `ToolExecutionResult`'a **dinamik** `mutatedWorkspace` eklendi. `delegate`,
  çalıştırdığı alt agent workspace'i değiştirdiyse `mutatedWorkspace: true`
  bildirir; `ToolRegistry` bunu statik bildirimle OR'lar (yalnızca başarıda).
  Ana döngü kendi `hasMutated`'ını set eder ve Phase 4 kapısı devreye girer.
  `RunResult.mutatedWorkspace` bu yayılımı çağırana görünür kılar.
- **Alt agent çıktısı untrusted:** `delegate`, alt agent'ın cevabını
  `wrapUntrusted` ile sarar (tıpkı `knowledge_search` gibi). Kendi modelimizin
  metni, ama researcher sık sık sayfa alıntılar; özetlediği içerikle aynı
  güven tarafında durur.
- **İki seviyeli bütçe:** Delegasyon başına rol bütçesi + koşu başına
  `maxSubAgents` (varsayılan 3). Bütçe bitince `delegate` hata sonucu döner
  ve modele söylenir; koşu patlamaz. `AURORA_MAX_SUB_AGENTS=0` delegasyonu
  tamamen kapatır — registry tam olarak Phase 5 öncesi halidir.
- **Config:** `AURORA_MAX_SUB_AGENTS`. **CLI:** `aurora run --max-sub-agents <n>`.

## Değişen Dosyalar

- `src/core/agent/roles/types.ts` (yeni) — `AgentRole`, `RoleDefinition`,
  `RoleBudget`.
- `src/core/agent/roles/definitions.ts` (yeni) — `ROLE_DEFINITIONS`,
  `roleDefinition`.
- `src/core/agent/roles/index.ts` (yeni).
- `src/core/agent/subagent/types.ts` (yeni) — `SubAgentRequest/Result`,
  `RoleToolsetBuilder`, `SubAgentManagerPort`.
- `src/core/agent/subagent/SubAgentManager.ts` (yeni).
- `src/core/agent/subagent/index.ts` (yeni).
- `src/core/agent/types.ts` — `ToolExecutionResult.mutatedWorkspace` (dinamik),
  `RunResult.mutatedWorkspace`.
- `src/core/agent/AgentLoop.ts` — `finish()` `hasMutated`'ı raporlar.
- `src/core/agent/AgentRuntime.ts` — manager kurulumu + `delegate` kaydı
  (iki adımlı wiring; döngüsel bağımlılık için).
- `src/core/agent/index.ts` — yeni export'lar.
- `src/tools/types.ts` — `ToolResult.mutatedWorkspace`.
- `src/tools/ToolRegistry.ts` — dinamik mutasyonu statikle OR'lar.
- `src/tools/agent/DelegateTool.ts` (yeni).
- `src/tools/index.ts` — katalog + rol registry'leri + `intersectPermissions`.
- `src/config/Config.ts`, `.env.example`, `src/cli/commands/run.ts`,
  `vitest.config.ts`.

## Çalıştırılan Testler

| Test | Sonuç | Not |
|---|---|---|
| `tests/unit/agent/roles.test.ts` (7) | PASS | `delegate` hiçbir rolde yok; `FULL_ACCESS` yok; bütçeler > 0 |
| `tests/unit/agent/subagent-manager.test.ts` (8) | PASS | Context izolasyonu; rol bütçesi; `maxSubAgents`; mutation yayılımı |
| `tests/unit/tools/delegate-tool.test.ts` (7) | PASS | Rol/task geçişi; untrusted sarma; mutation raporu; rol doğrulama |
| `tests/unit/tools/tool-registry.test.ts` (26) | PASS | Dinamik mutasyon OR'u (yeni 2 test) |
| `tests/integration/role-toolsets.test.ts` (9) | PASS | Gerçek builder: `delegate` rol registry'lerinde yok; izin kesişimi |
| `tests/integration/subagent-live.test.ts` (1) | PASS | **Gerçek** model → gerçek `delegate` → gerçek dosya diskte |
| **Tam suite** | **292 PASS, 0 SKIP** | 30 dosya; 5 canlı Ollama entegrasyonu gerçekten koştu |

Mutasyon testi (testlerin gerçekten yakaladığını kanıtlamak için):
- `ToolRegistry`'de dinamik OR kaldırılınca → **yakalanmadı** → test eklendi;
  şimdi yakalanıyor.
- `delegate`'te `mutatedWorkspace` raporu kaldırılınca → 1 test FAIL.
- Rol izin kesişimi `definition.maxPermissions` ile değiştirilince → 2 test FAIL.
- Coder rolüne `delegate` eklenince → 1 test FAIL.
- `SubAgentManager`'da `remaining() <= 0` guard'ı `false` yapılınca → 1 test FAIL.
- Rol `maxVerifications` 3 yapılınca → 1 test FAIL.

## Kullanılan Kaynaklar

- `docs/research/multi-agent.md` — supervisor-worker / maker-checker şekli,
  context izolasyonunun asıl amaç olduğu, in-process tercihi, bütçe+izin
  gerekliliği (2026-09-28 erişimli kaynaklar: MLflow, futureagi.com,
  digitalapplied.com, arahi.ai).
- `docs/adr/001-core-architecture.md` (katman yönü), ADR 004 (izin modeli),
  ADR 006 (harici doğrulama).
- Node.js v24.21.0 — `fileParallelism: false` gerekliliği bu makinede
  ölçülerek doğrulandı.

## Alınan Kararlar

- Alt agent'lar aynı process içinde, rol tabanlı instance'lardır; mikroservis
  değil (ADR 007).
- Delegasyon bir **tool**'dur; runtime kendi kendine spawn etmez — böylece
  trajectory'de görünür ve bütçe modelin isteğiyle harcanır.
- Alt agent ana geçmişi görmez; rol prompt'u ana prompt'u değiştirir.
- Least privilege **yapısaldır**: rol registry'sinde olmayan tool, o role
  göre yoktur. Reviewer yazamaz çünkü yazma yeteneği dünyasında yoktur.
- Alt agent'lar delega edemez; bu bir derinlik sayacıyla değil, `delegate`'in
  rol kataloğunda bulunmamasıyla garanti edilir.
- Delege edilen düzenleme ana doğrulayıcıyı tetikler (ADR 006 genişletmesi).
- Alt agent cevabı untrusted data olarak sarılır.
- Delegasyon opt-in; `AURORA_MAX_SUB_AGENTS=0` Phase 1–4 davranışını korur.

## Varsayımlar

- Ana model, kendi kendine yeterli bir görev metni yazabilecek kadar
  yetkinlidir. Belirsiz delegasyon belirsiz sonuç verir ve ana agent alt
  agent'ın akıl yürütmesini göremez — yalnızca nihai cevabı. Bu, context
  izolasyonunun doğal bedelidir; rol prompt'ları bu yüzden "iyi cevap nasıl
  olur"u tarif eder.
- Alt agent'ların paralel çalıştırılması gerekli değildir. Sıralı delegasyon
  bütçe muhasebesini tam tutar.
- Tek bir `delegate` çağrısı tek bir alt agent çalıştırır; çoklu rol
  zincirlemesi ana modelin kararıdır.

## Kalan Problemler

- Delege edilen işin doğrulaması **kaba**: ana agent doğrulayıcıyı delegasyon
  döndükten sonra çalıştırır, içinde değil. Bozuk kod yazan ve başarı bildiren
  bir alt agent ana doğrulayıcıya yakalanır — ama delegasyon bittikten sonra.
- Hiçbir rol şu an `maxVerifications > 0` taşımıyor: tester'ın kendi
  doğrulama bütçesi olması doğal bir sonraki adım, ama şu an ana agent zaten
  aynı kontrolü yapıyor; ikinci bir kontrol maliyeti ikiye katlardı.
- Alt agent başına token muhasebesi yok (araştırmada DOĞRULANACAK olarak
  işaretliydi). Bütçe iterasyon ve tool çağrısıyla sınırlı, token'la değil.
- Paralellik yok (bilinçli deferral).

## Sonraki Faz İçin Notlar

- Phase 6 (persistence): delegasyon sonuçları ve `maxSubAgents` sayacı
  persist edilmeli ki restart sonrası bütçe sıfırlanmasın. `max_verifications`
  durumu `failed`den ayrı bir son durum olarak saklanmalı (Phase 4 notu hâlâ
  geçerli).
- Phase 7 (context): alt agent çıktısı ana bağlama girerken untrusted
  sarılmış halde giriyor; compaction bunu tek blok olarak budayabilir.
- Phase 8 (security): rol izin tavanları `PermissionManager`'ın üstüne
  oturuyor; allowlist/denylist genişletmesi bu tavanları etkilememeli.
- Phase 9 (API): `POST /agent/run` delegasyonları da trajectory'de
  göstermeli; UI (Phase 10) agent panelinde ana/alt agent ayrımını bu
  veriden çizebilir.
