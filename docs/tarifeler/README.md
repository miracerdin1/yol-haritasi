# Köprü ve otoyol ücret tarifeleri

Masraf hesabındaki ([src/lib/cost.ts](../../src/lib/cost.ts)) köprü ücretleri ve otoyol km ücretleri KGM'nin 2026 tarife tablolarından çıkarıldı. Bu dosya o tabloların otomobil için özetidir.

- **Kaynak:** KGM, [Otoyol ve Köprü Geçiş Ücretleri](https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Otoyollar/UcretlerYeni.aspx) (22 Ekim 2026'da okundu). Aşağıdaki "PDF" sütunu o sayfadaki dosya numarasıdır (ör. 13 = `13-YSSKuzeyCevreYolu.pdf`).
- **Geçerlilik:** KGM işletmesindeki yollar (15 Temmuz/FSM, Anadolu, Avrupa, İzmir–Çeşme, İzmir–Aydın, Çukurova) **1 Ocak 2026**'dan beri geçerli; Temmuz'da değişmedi. Özel işletmeli (YİD/KÖİ) köprü ve otoyollar **1 Temmuz 2026**'dan, Çeşmeli–Kızkalesi **19 Ekim 2026**'dan beri geçerli.
- Tüm tutarlar KDV dahil.

## Otomobil (1. sınıf) özeti

### Köprü ve tüneller (iki yönde de ücretli)

| Geçiş | Ücret | PDF |
|---|---|---|
| 15 Temmuz Şehitler / Fatih Sultan Mehmet | 59 TL | 1 |
| Osmangazi | 1.170 TL | 2 |
| Yavuz Sultan Selim | 110 TL | 3 |
| 1915 Çanakkale | 1.170 TL | 4 |
| Avrasya Tüneli | 330 TL gündüz, 165 TL gece | KGM listesinde yok (haber kaynağı) |

PDF 1'deki not: "01.01.2022 tarihinden itibaren FSM ve 15 Temmuz Şehitler Köprülerinden iki yönlü ücret alınmaktadır."

### Otoyollar: tam parkur ve uygulamadaki km ücreti

Uygulamadaki km ücreti, tam parkur ücretinin (köprü dahilse köprü düşülerek) yolun uzunluğuna bölünmesiyle bulundu. Uzunluk olarak uygulamanın kendi ölçümü (OSRM rotası ve `cost.ts` sınıflandırması) kullanıldı; KGM tablolarında mesafe yazıyorsa onunla karşılaştırıldı.

| Yol | Tam parkur | Ücret | Uzunluk | TL/km | PDF |
|---|---|---|---|---|---|
| Kuzey Marmara Avrupa (O-7) | Kınalı → Fatih | 260 | 53 km | 4,9 | 14 |
| Kuzey Çevre + YSS (O-7) | Odayeri → Kurnaköy | 520 (YSS dahil) | 88 km | 4,7 | 13 |
| Kuzey Marmara Anadolu (O-7) | Kurnaköy 2 → TEM Akyazı | 600 | 126 km | 4,8 | 15 |
| İstanbul–İzmir (O-5) | Osmangazi → Bursa Kuzey + Bursa Batı → İzmir | 1.170 + 370 + 1.355 = 2.895 | 359 km | 4,8 | 12 |
| Malkara–Çanakkale (O-6) | Malkara → 1915 Köprüsü | 1.480 (köprü dahil) | 65 km | 4,8 | 18 |
| Ankara–Niğde (O-21) | Ankara Alın → Niğde Alın | 925 | 265 km | 3,5 | 17 |
| Aydın–Denizli (O-31) | Aydın Alın → Kocabaş | 590 | 151 km | 3,9 | 19 |
| Menemen–Çandarlı (O-33) | Menemen → Çandarlı | 240 | 51 km | 4,7 | 16 |
| Anadolu Otoyolu (O-4) | Çamlıca → Akıncı | 338 | 380,7 km | 0,89 | 5 |
| Avrupa Otoyolu (O-3) | Mahmutbey → Edirne | 168 | 211,9 km | 0,79 | 11 |
| İzmir–Çeşme (O-32) | Seferihisar → Çeşme | 53 | 56,3 km | 0,94 | 6 |
| İzmir–Aydın (O-31) | Işıkkent → Aydın Batı | 73 | 88,6 km (tablo 99,6) | 0,82 | 7 |
| Adana–Gaziantep (O-52) | Adana Doğu → Gaziantep Batı | 102 | 157 km | 0,65 | 8 |
| Gaziantep–Şanlıurfa (O-52) | Gaziantep Doğu → Şanlıurfa | 102 | 120 km | 0,85 | 9 |
| Niğde–Mersin (O-21) | Niğde Güney → Mersin | 184 | 182,5 km | 1,0 | 10 |
| Ceyhan–İskenderun (O-53) | Ceyhan → İskenderun | 65 | 77 km | 0,84 | 8 |
| Çeşmeli–Kızkalesi | Çeşmeli → Kızkalesi | 220 | | | 20 (uygulamada yok) |

KGM yollarında kısa girişlerde gişe en az ~40 TL alıyor; uygulama her ayrı girişe en az 40 TL sayıyor.

## Bilinen sınırlar

- Tarife gişeden gişeye. Km ortalaması tam parkurda tutuyor, kısa yolculuklarda ~%10-15 sapabilir. Gişe-gişe tam ücret için tablolar burada hazır; eksik olan gişelerin haritadaki yerleri.
- Serbest geçiş (SGS) noktalarının ücretleri (ör. Kuzey Çevre'de Çamlık 49 TL, Fenertepe 41 TL) ayrıca sayılmıyor.
- İstanbul → İzmir yönünde Osmangazi gişesinde yalnızca köprü ücreti, çıkış gişesinde otoyol ücreti alınıyor; İzmir → İstanbul yönünde ikisi birlikte köprüde alınıyor. Toplam tutar aynı.
- Kınalı–Malkara (O-6'nın Malkara'nın doğusu) bu tablolarda yok; uygulamada "Diğer paralı yollar" olarak görünür.

## Güncelleme (her Ocak ve Temmuz)

1. KGM sayfasındaki yeni PDF'lerden otomobil ücretlerini oku.
2. Köprü ücretlerini `cost.ts` içindeki `FACILITIES`'te, tam parkur ücretlerini yukarıdaki tabloda güncelle.
3. Km ücretlerini (`TOLL_ROADS`) yeni tam parkur ücreti ÷ aynı uzunluk olarak yeniden hesapla ve `TARIFF_DATE`'i değiştir.
