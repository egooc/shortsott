-- AI 오피스 1주차(보기 전용) 표. 그로우업 메인 프로젝트 public 에 office_ 접두사로 둔다
-- (새 프로젝트 불가·스키마 노출 설정 변경을 피하려고). 고객 표는 건드리지 않는다.
-- 쓰기는 VPS 오피스 서버(service role)만, 읽기는 소유주 계정 하나만.
-- 소유주 = 사이트에서 실제 쓰는 계정(10-29 소유주 선택).

create table if not exists public.office_snapshots (
  device     text primary key,
  at         timestamptz not null,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.office_decisions (
  id           bigint generated always as identity primary key,
  lane         text not null,
  question     text not null,
  options      jsonb not null default '[]'::jsonb,
  recommended  text,
  status       text not null default 'open' check (status in ('open', 'answered', 'withdrawn')),
  answer       text,
  answered_at  timestamptz,
  asked_by     text,
  created_at   timestamptz not null default now()
);
create index if not exists office_decisions_open on public.office_decisions (status, created_at desc);

alter table public.office_snapshots enable row level security;
alter table public.office_decisions enable row level security;

drop policy if exists office_owner_read on public.office_snapshots;
create policy office_owner_read on public.office_snapshots
  for select to authenticated using (auth.uid() = '6affc94a-0d3b-4033-a219-a57a2213b289'::uuid);

drop policy if exists office_owner_read on public.office_decisions;
create policy office_owner_read on public.office_decisions
  for select to authenticated using (auth.uid() = '6affc94a-0d3b-4033-a219-a57a2213b289'::uuid);

-- anon 은 아무것도 못 본다(정책 없음). 2주차 결정 버튼 때 소유주 update 정책을 추가한다.
