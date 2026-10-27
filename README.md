# Państwa-Miasta online

Gra w Państwa-Miasta na telefonach. Jedna osoba zakłada grę i dostaje 4-literowy kod, reszta dołącza kodem albo linkiem. Aplikacja losuje litery, odlicza czas po „Stop!”, sprawdza odpowiedzi i liczy punkty.

Statyczna strona (HTML + CSS + JS, bez budowania) — działa na GitHub Pages. Komunikacja między graczami idzie przez Supabase Realtime (darmowy plan).

## Wrzucenie na GitHub Pages

1. Na GitHubie: **New repository** → nazwa np. `panstwa-miasta` → **Public** → Create.
2. **Add file → Upload files** → przeciągnij całą zawartość tego folderu (`index.html`, `css/`, `js/`, `README.md`) → Commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. Po ~1 minucie gra działa pod `https://<twój-login>.github.io/panstwa-miasta/`.

Albo z terminala:

```bash
git init && git add . && git commit -m "Państwa-Miasta"
git branch -M main
git remote add origin https://github.com/<login>/panstwa-miasta.git
git push -u origin main
```

## Jak się gra

1. Gospodarz wpisuje imię → **Załóż nową grę** → dostaje kod (np. `KOTA`) i przycisk **Wyślij zaproszenie** (link z kodem).
2. Gracze wpisują imię i kod → **Dołącz**. Gospodarz widzi listę, ustawia liczbę rund, czas po „Stop!” i kategorie (można dodać własne).
3. **Zaczynamy** → losowanie litery → wszyscy wpisują odpowiedzi.
4. Kto pierwszy wypełni wszystkie pola (na właściwą literę), wciska **Stop!** — reszta ma ustawiony czas na dokończenie. Gdy wszyscy wcisną „Gotowe”, runda kończy się od razu. Gdy nikt nie może skończyć, gospodarz może włączyć odliczanie ręcznie.
5. **Sprawdzanie**: aplikacja ocenia odpowiedzi, gracze głosują ✓/✗ przy wątpliwych, gospodarz zatwierdza punkty.
6. Po ostatniej rundzie — tabela wyników i zwycięzca. **Zagraj jeszcze raz** zaczyna od nowa z tymi samymi osobami.

### Punktacja

| Punkty | Kiedy |
|---|---|
| 15 | tylko Ty masz zaliczoną odpowiedź w tej kategorii |
| 10 | Twoja odpowiedź jest inna niż wszystkich |
| 5 | ktoś napisał to samo (wielkość liter i polskie znaki nie mają znaczenia) |
| 0 | brak, zła litera albo odrzucone |

### Sprawdzanie odpowiedzi

1. **Litera** — odpowiedź musi zaczynać się na literę rundy (Ł to nie L, Ż to nie Z).
2. **Słownik wbudowany** (`js/dict.js`) — ok. 3000 słów: państwa, miasta, rzeki, zwierzęta, rośliny, imiona, rzeczy, zawody, owoce/warzywa, kolory, sporty. Porównanie ignoruje polskie znaki, więc „krakow” = „Kraków”.
3. **Online** (u gospodarza, dla słów spoza słownika): Wikidata sprawdza, czy to naprawdę miasto/rzeka/państwo/zwierzę…, Wikisłownik — czy „rzecz” jest polskim rzeczownikiem.
4. **Głosowanie** — „pasuje” liczy się, chyba że większość da ✗; „nie znam” liczy się tylko, gdy większość da ✓; własne kategorie („do oceny”) liczą się, chyba że większość da ✗. Nie głosujesz na siebie.

## Pliki

```
index.html        strona
css/style.css     wygląd (zeszyt w kratkę, tryb ciemny)
js/app.js         ekrany, akcje graczy, logika gospodarza
js/game.js        zasady: litery, punktacja, ranking (bez DOM — łatwe do testów)
js/validator.js   sprawdzanie: słownik + Wikidata + Wikisłownik
js/dict.js        słowniki (dopisuj słowa po przecinku)
js/net.js         komunikacja: Supabase Realtime albo tryb lokalny
js/config.js      adres i klucz Supabase
```

### Jak to działa pod spodem

- Gospodarz trzyma oficjalny stan gry i rozsyła go wszystkim po każdej zmianie (kanał `panstwa-miasta:<KOD>`).
- Gracze wysyłają tylko swoje akcje: dołączenie, Stop, odpowiedzi, głosy.
- Odliczanie liczy gospodarz; telefony graczy synchronizują zegar z jego czasem.
- Odpowiedzi w trakcie rundy zapisują się w telefonie — odświeżenie strony nie kasuje wpisanych słów, a gracz wraca do gry automatycznie.
- Ekran nie gaśnie w trakcie rundy (Wake Lock), jeśli przeglądarka na to pozwala.

## Ograniczenia, o których warto wiedzieć

- **Gospodarz musi mieć otwartą grę.** Jeśli zamknie kartę albo zablokuje telefon na dłużej, gra stanie, dopóki nie wróci (stan się zapisuje — po powrocie gra toczy się dalej).
- **Darmowy projekt Supabase usypia się po 7 dniach bez ruchu.** Gdy gra nie łączy się po dłuższej przerwie, wejdź na supabase.com → projekt → **Restore project**.
- Sprawdzanie online robi tylko gospodarz i czeka na nie maksymalnie ~10 s; jeśli Wikidata nie odpowie, słowa trafiają do głosowania.
- Gracz z odrobiną wiedzy technicznej mógłby podejrzeć cudze odpowiedzi w narzędziach przeglądarki — ale dopiero po końcu rundy, więc nie da się w ten sposób ściągać.

## Własny projekt Supabase

W `js/config.js` podmień `SUPABASE_URL` i `SUPABASE_KEY` (Supabase → Project Settings → API → *Project URL* i klucz *anon / publishable*). Gra nie tworzy tabel — potrzebuje tylko Realtime z włączonym „Allow public access” (domyślnie włączone).

## Testy bez internetu

Dopisz `?local=1` do adresu: gracze to karty tej samej przeglądarki (BroadcastChannel zamiast Supabase). Przydatne przy zmianach w kodzie.

```bash
python3 -m http.server 8000
# http://localhost:8000/?local=1 w kilku kartach
```
