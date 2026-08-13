-- Agroserwis Nysa — schemat bazy Supabase
-- Zlecenia trzymane per token (token = publiczny identyfikator śledzenia).
-- Dostęp tylko przez service_role (desktop + Edge Function); RLS bez polityk
-- blokuje klucz anon całkowicie.

create table if not exists zlecenia (
  token text primary key,
  id_desktop bigint,
  numer text not null default '',
  klient_nazwa text not null default '',
  klient_telefon text not null default '',
  klient_email text not null default '',
  marka text not null default '',
  model text not null default '',
  nr_seryjny text not null default '',
  opis_usterki text not null default '',
  uwagi text not null default '',
  status text not null default 'Przyjęto',
  data_przyjecia timestamptz,
  data_gotowosci timestamptz,
  data_wydania timestamptz,
  koszt_robocizny numeric not null default 0,
  czesci jsonb not null default '[]',
  zrodlo text not null default '',
  -- false = nowa reklamacja z WWW, czeka aż desktop ją pobierze
  pobrane boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists zdjecia (
  id bigint generated always as identity primary key,
  token text not null references zlecenia(token) on delete cascade,
  typ text not null default 'przed',
  path text not null,
  -- false = desktop jeszcze nie ściągnął zdjęcia do siebie
  pobrane boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists zlecenia_pobrane_idx on zlecenia (pobrane) where not pobrane;
create index if not exists zdjecia_pobrane_idx on zdjecia (pobrane) where not pobrane;

alter table zlecenia enable row level security;
alter table zdjecia  enable row level security;
-- celowo brak polityk RLS: anon nie ma dostępu, service_role omija RLS

-- Publiczny bucket na zdjęcia (odczyt po URL; zapis tylko service_role)
insert into storage.buckets (id, name, public)
values ('zdjecia', 'zdjecia', true)
on conflict (id) do nothing;
