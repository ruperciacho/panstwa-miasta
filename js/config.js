// Połączenie z Supabase Realtime (kanały broadcast + presence).
// Gra NIE używa bazy danych — tylko kanałów czasu rzeczywistego, więc wystarczy klucz publiczny (anon).
// Klucz anon jest z założenia jawny; bezpieczeństwo bazy zapewnia RLS w projekcie.
//
// Chcesz użyć innego projektu? Podmień obie wartości (Supabase → Project Settings → API).
// Puste SUPABASE_URL = tryb lokalny (gracze w kartach jednej przeglądarki, do testów).
export const CONFIG = {
  SUPABASE_URL: 'https://jxwpdyvzddyewdgcazxk.supabase.co',
  SUPABASE_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3BkeXZ6ZGR5ZXdkZ2NhenhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1NDI0NTUsImV4cCI6MjEwODExODQ1NX0.d5-X6Icka8vP9YRZirfJlWS65asPNhc8qV_-zN7kmec',
  // Prefiks nazw kanałów — żeby gra nie kolidowała z innymi aplikacjami w tym samym projekcie.
  CHANNEL_PREFIX: 'panstwa-miasta:',
  // Sprawdzanie odpowiedzi w Wikidata / Wikisłowniku, gdy nie ma ich we wbudowanym słowniku.
  ONLINE_CHECK: true,
};
