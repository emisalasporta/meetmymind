-- MeetMyMind · estructura inicial del fichero
-- Todo lo que guarda el lugar vive en estas tablas. Los nombres están en
-- español a propósito: cualquier persona o IA que abra esto tiene que poder
-- entenderlo sin un diccionario.

create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- Texto sin acentos y en minúsculas, para buscar "perez" y encontrar "Pérez".
create or replace function mmm_normalizar(t text) returns text
  language sql immutable parallel safe
  as $$ select lower(public.unaccent('public.unaccent', coalesce(t, ''))) $$;

-- ---------------------------------------------------------------------------
-- CAPAS: las grandes divisiones. Sumar una capa es agregar una fila.
-- ---------------------------------------------------------------------------
create table capas (
  clave        text primary key,
  nombre       text not null,
  descripcion  text not null default '',
  orden        int  not null default 0
);

-- ---------------------------------------------------------------------------
-- FICHAS: cada cosa que existe (una persona, una reunión, un proyecto, un
-- gusto, un valor, un criterio del manual).
-- ---------------------------------------------------------------------------
create table fichas (
  id           uuid primary key default gen_random_uuid(),
  capa         text not null references capas(clave),
  tipo         text not null default '',
  titulo       text not null check (length(btrim(titulo)) > 0),
  cuerpo       text not null default '',
  datos        jsonb not null default '{}'::jsonb check (jsonb_typeof(datos) = 'object'),
  alias        text[] not null default '{}',
  fecha        date,
  origen       text not null default '',
  origen_ref   text not null default '',
  estado       text not null default 'activa'
               check (estado in ('activa', 'archivada', 'borrada')),
  creada       timestamptz not null default now(),
  actualizada  timestamptz not null default now(),
  nombres      text not null default '',
  busqueda     tsvector
);

create index fichas_capa_idx     on fichas (capa, estado, actualizada desc);
create index fichas_fecha_idx    on fichas (fecha desc) where fecha is not null;
create index fichas_busqueda_idx on fichas using gin (busqueda);
create index fichas_nombres_idx  on fichas using gin (nombres gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- APUNTES: los datos sueltos de una ficha. Cada uno dice de dónde salió,
-- de cuándo es y en qué se apoya.
-- ---------------------------------------------------------------------------
create table apuntes (
  id               uuid primary key default gen_random_uuid(),
  ficha_id         uuid not null references fichas(id),
  texto            text not null check (length(btrim(texto)) > 0),
  fecha            date,
  base             text not null default 'dicho_por_emiliano'
                   check (base in ('dicho_por_emiliano', 'deducido_por_alex',
                                   'dicho_por_otro', 'registro')),
  origen           text not null default '',
  origen_ref       text not null default '',
  hecho_id         uuid references fichas(id),
  vigente          boolean not null default true,
  reemplazado_por  uuid references apuntes(id),
  estado           text not null default 'activo'
                   check (estado in ('activo', 'borrado')),
  creado           timestamptz not null default now(),
  actualizado      timestamptz not null default now(),
  busqueda         tsvector
);

create index apuntes_ficha_idx    on apuntes (ficha_id, estado, fecha desc nulls last, creado desc);
create index apuntes_hecho_idx    on apuntes (hecho_id) where hecho_id is not null;
create index apuntes_busqueda_idx on apuntes using gin (busqueda);

-- ---------------------------------------------------------------------------
-- ENLACES: la conexión entre dos fichas, con el nombre de la relación.
-- ---------------------------------------------------------------------------
create table enlaces (
  id        uuid primary key default gen_random_uuid(),
  desde     uuid not null references fichas(id),
  hacia     uuid not null references fichas(id),
  relacion  text not null default '',
  nota      text not null default '',
  creado    timestamptz not null default now(),
  check (desde <> hacia),
  unique (desde, hacia, relacion)
);

create index enlaces_hacia_idx on enlaces (hacia);

-- ---------------------------------------------------------------------------
-- ARCHIVOS: imágenes y documentos. El archivo vive en la carpeta de datos;
-- acá queda la referencia.
-- ---------------------------------------------------------------------------
create table archivos (
  id           uuid primary key default gen_random_uuid(),
  ficha_id     uuid not null references fichas(id),
  nombre       text not null,
  tipo         text not null,
  bytes        bigint not null,
  ruta         text not null,
  ancho        int,
  alto         int,
  descripcion  text not null default '',
  estado       text not null default 'activo'
               check (estado in ('activo', 'borrado')),
  creado       timestamptz not null default now()
);

create index archivos_ficha_idx on archivos (ficha_id, estado, creado);

-- ---------------------------------------------------------------------------
-- BANDEJA: lo crudo cae acá antes de archivarse en su capa.
-- ---------------------------------------------------------------------------
create table bandeja (
  id          uuid primary key default gen_random_uuid(),
  recibido    timestamptz not null default now(),
  origen      text not null default '',
  origen_ref  text not null default '',
  fecha       date,
  contenido   text not null check (length(btrim(contenido)) > 0),
  datos       jsonb not null default '{}'::jsonb,
  estado      text not null default 'pendiente'
              check (estado in ('pendiente', 'archivado', 'descartado')),
  resuelto    timestamptz,
  nota        text not null default '',
  fichas      uuid[] not null default '{}'
);

create index bandeja_estado_idx on bandeja (estado, recibido desc);

-- ---------------------------------------------------------------------------
-- HISTORIAL: todo cambio queda acá, lo haga quien lo haga. Lo llenan los
-- disparadores de más abajo, no el programa: no hay forma de saltearlo.
-- ---------------------------------------------------------------------------
create table historial (
  id          bigint generated always as identity primary key,
  cuando      timestamptz not null default now(),
  quien       text not null,
  accion      text not null,
  tabla       text not null,
  registro    text not null,
  ficha_id    uuid,
  otra_ficha  uuid,
  antes       jsonb,
  despues     jsonb,
  motivo      text not null default ''
);

create index historial_cuando_idx on historial (cuando desc, id desc);
create index historial_ficha_idx  on historial (ficha_id, id desc) where ficha_id is not null;
create index historial_otra_idx   on historial (otra_ficha, id desc) where otra_ficha is not null;

-- ---------------------------------------------------------------------------
-- ACCESO: quién puede entrar.
-- ---------------------------------------------------------------------------

-- Sesiones de la web (Emiliano con su clave).
create table sesiones (
  id_hash     text primary key,
  creada      timestamptz not null default now(),
  ultimo_uso  timestamptz not null default now(),
  vence       timestamptz not null
);

-- Intentos de entrar, para frenar a quien pruebe claves.
create table intentos (
  id      bigint generated always as identity primary key,
  cuando  timestamptz not null default now(),
  ip      text not null,
  bien    boolean not null
);

create index intentos_cuando_idx on intentos (cuando desc);

-- Programas (las apps de IA) que pidieron conectarse.
create table oauth_clientes (
  client_id  text primary key,
  datos      jsonb not null,
  creado     timestamptz not null default now()
);

-- Pedidos de conexión esperando que Emiliano diga sí o no.
create table oauth_solicitudes (
  id         text primary key,
  client_id  text not null references oauth_clientes(client_id) on delete cascade,
  params     jsonb not null,
  creado     timestamptz not null default now(),
  vence      timestamptz not null
);

-- ACCESOS: una fila por cada IA autorizada. Se revoca desde la web.
create table accesos (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null references oauth_clientes(client_id) on delete cascade,
  nombre      text not null,
  alcance     text[] not null default '{}',
  recurso     text not null default '',
  creado      timestamptz not null default now(),
  ultimo_uso  timestamptz,
  revocado    timestamptz
);

create table oauth_codigos (
  codigo_hash     text primary key,
  acceso_id       uuid not null references accesos(id) on delete cascade,
  client_id       text not null,
  redirect_uri    text not null,
  code_challenge  text not null,
  vence           timestamptz not null,
  usado           timestamptz
);

create table oauth_tokens (
  token_hash  text primary key,
  acceso_id   uuid not null references accesos(id) on delete cascade,
  tipo        text not null check (tipo in ('acceso', 'refresco')),
  creado      timestamptz not null default now(),
  vence       timestamptz not null,
  usado       timestamptz
);

create index oauth_tokens_acceso_idx on oauth_tokens (acceso_id);

-- LLAVES: contraseñas largas para programas propios (automatizaciones).
create table llaves (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  token_hash  text not null unique,
  creado      timestamptz not null default now(),
  ultimo_uso  timestamptz,
  revocada    timestamptz
);

-- ---------------------------------------------------------------------------
-- DISPARADORES
-- ---------------------------------------------------------------------------

-- Mantiene al día los campos de búsqueda de una ficha.
create or replace function mmm_ficha_preparar() returns trigger
  language plpgsql as $$
begin
  new.titulo  := btrim(new.titulo);
  new.nombres := mmm_normalizar(new.titulo || ' | ' || array_to_string(new.alias, ' | '));
  new.busqueda :=
      setweight(to_tsvector('spanish', mmm_normalizar(new.titulo || ' ' || array_to_string(new.alias, ' '))), 'A')
   || setweight(to_tsvector('spanish', mmm_normalizar(new.tipo)), 'B')
   || setweight(to_tsvector('spanish', mmm_normalizar(new.cuerpo)), 'C')
   || setweight(to_tsvector('spanish', mmm_normalizar(new.datos::text)), 'D');
  if tg_op = 'UPDATE' then
    new.actualizada := now();
  end if;
  return new;
end $$;

create trigger fichas_preparar before insert or update on fichas
  for each row execute function mmm_ficha_preparar();

create or replace function mmm_apunte_preparar() returns trigger
  language plpgsql as $$
begin
  new.busqueda := to_tsvector('spanish', mmm_normalizar(new.texto));
  if tg_op = 'UPDATE' then
    new.actualizado := now();
  end if;
  return new;
end $$;

create trigger apuntes_preparar before insert or update on apuntes
  for each row execute function mmm_apunte_preparar();

-- Cuando cambia algo de una ficha (un apunte, un archivo, un enlace),
-- la ficha figura como actualizada.
create or replace function mmm_tocar_ficha() returns trigger
  language plpgsql as $$
declare
  fila jsonb := to_jsonb(coalesce(new, old));
begin
  if tg_table_name = 'enlaces' then
    update fichas set actualizada = now()
     where id in ((fila->>'desde')::uuid, (fila->>'hacia')::uuid);
  else
    update fichas set actualizada = now() where id = (fila->>'ficha_id')::uuid;
  end if;
  return null;
end $$;

create trigger apuntes_tocar  after insert or update or delete on apuntes
  for each row execute function mmm_tocar_ficha();
create trigger archivos_tocar after insert or update or delete on archivos
  for each row execute function mmm_tocar_ficha();
create trigger enlaces_tocar  after insert or update or delete on enlaces
  for each row execute function mmm_tocar_ficha();

-- El historial. Argumentos del disparador:
--   1) columnas que no cuentan como cambio, separadas por coma
--   2) columna que identifica el registro
--   3) columna con la ficha afectada ('' si no hay)
--   4) columna con la otra ficha afectada ('' si no hay)
create or replace function mmm_registrar() returns trigger
  language plpgsql as $$
declare
  v_quien    text := coalesce(nullif(current_setting('mmm.quien', true), ''), 'sistema');
  v_motivo   text := coalesce(current_setting('mmm.motivo', true), '');
  v_ignorar  text[] := string_to_array(tg_argv[0], ',');
  v_viejo    jsonb;
  v_nuevo    jsonb;
  v_antes    jsonb := '{}'::jsonb;
  v_despues  jsonb := '{}'::jsonb;
  v_fila     jsonb;
  v_accion   text;
  k          text;
begin
  if tg_op = 'INSERT' then
    v_fila    := to_jsonb(new);
    v_antes   := null;
    v_despues := jsonb_strip_nulls(v_fila - v_ignorar);
    v_accion  := 'crear';
  elsif tg_op = 'DELETE' then
    v_fila    := to_jsonb(old);
    v_antes   := jsonb_strip_nulls(v_fila - v_ignorar);
    v_despues := null;
    v_accion  := 'borrar';
  else
    v_viejo := to_jsonb(old) - v_ignorar;
    v_nuevo := to_jsonb(new) - v_ignorar;
    v_fila  := to_jsonb(new);
    for k in select jsonb_object_keys(v_nuevo) loop
      if (v_viejo -> k) is distinct from (v_nuevo -> k) then
        v_antes   := v_antes   || jsonb_build_object(k, v_viejo -> k);
        v_despues := v_despues || jsonb_build_object(k, v_nuevo -> k);
      end if;
    end loop;
    if v_despues = '{}'::jsonb then
      return null;
    end if;
    v_accion := 'editar';
    if v_despues ? 'estado' then
      if v_despues ->> 'estado' in ('borrada', 'borrado') then
        v_accion := 'borrar';
      elsif v_antes ->> 'estado' in ('borrada', 'borrado') then
        v_accion := 'restaurar';
      end if;
    end if;
  end if;

  insert into historial (quien, accion, tabla, registro, ficha_id, otra_ficha, antes, despues, motivo)
  values (
    v_quien, v_accion, tg_table_name, v_fila ->> tg_argv[1],
    case when tg_argv[2] <> '' then (v_fila ->> tg_argv[2])::uuid end,
    case when tg_argv[3] <> '' then (v_fila ->> tg_argv[3])::uuid end,
    v_antes, v_despues, v_motivo
  );
  return null;
end $$;

create trigger fichas_historial after insert or update or delete on fichas
  for each row execute function mmm_registrar('busqueda,nombres,actualizada,creada', 'id', 'id', '');
create trigger apuntes_historial after insert or update or delete on apuntes
  for each row execute function mmm_registrar('busqueda,actualizado,creado', 'id', 'ficha_id', '');
create trigger enlaces_historial after insert or update or delete on enlaces
  for each row execute function mmm_registrar('creado', 'id', 'desde', 'hacia');
create trigger archivos_historial after insert or update or delete on archivos
  for each row execute function mmm_registrar('creado', 'id', 'ficha_id', '');
create trigger bandeja_historial after insert or update or delete on bandeja
  for each row execute function mmm_registrar('recibido', 'id', '', '');
create trigger capas_historial after insert or update or delete on capas
  for each row execute function mmm_registrar('', 'clave', '', '');
create trigger accesos_historial after insert or update or delete on accesos
  for each row execute function mmm_registrar('ultimo_uso,creado', 'id', '', '');
create trigger llaves_historial after insert or update or delete on llaves
  for each row execute function mmm_registrar('ultimo_uso,creado,token_hash', 'id', '', '');

-- El historial no se edita ni se borra: solo se le agrega.
create or replace function mmm_historial_fijo() returns trigger
  language plpgsql as $$
begin
  raise exception 'El historial no se modifica';
end $$;

create trigger historial_fijo before update or delete on historial
  for each row execute function mmm_historial_fijo();
