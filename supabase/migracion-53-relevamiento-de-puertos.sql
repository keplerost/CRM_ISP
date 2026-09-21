-- =============================================================================
-- Migración 53 — Que la pantalla de puertos no tarde treinta segundos
-- =============================================================================
-- Abrir "VLANs por puerto PON" tardaba 31 segundos. Medido, se reparte así:
--
--     leerPlacas             8.9 s
--     leerPuertosPon        14.7 s
--     leerVlansPorPuerto     7.7 s
--     la base                0.2 s
--
-- Las tres lecturas comparten la misma sesión SSH, así que van en fila aunque el
-- código las pida juntas. Y las dos primeras describen el HARDWARE: qué placas
-- tiene el equipo y cuántos puertos cada una. Eso no cambia salvo que alguien
-- cambie una tarjeta. Pagar veintitrés segundos por ese dato cada vez que se
-- abre la pantalla es tirar el tiempo del operador.
--
-- Se guarda lo relevado y la pantalla lee de acá: instantánea. Releer el equipo
-- pasa a ser un botón, como ya lo es en la ficha de la ONU.
--
-- Con `leido_at` se muestra DE CUÁNDO es lo que se está viendo. Un dato viejo
-- presentado como actual es peor que uno viejo con su fecha: el primero se toma
-- por cierto y el segundo se vuelve a leer.
-- =============================================================================

ALTER TABLE puertos_pon
    -- Qué placa es, para no tener que preguntarlo de nuevo.
    ADD COLUMN IF NOT EXISTS placa       TEXT,

    -- Las VLANs que el equipo tiene puestas en este puerto, con cuántos
    -- service-ports lleva cada una: [{"vlan":200,"service_ports":22}, …].
    -- Va como JSON y no en una tabla aparte porque siempre se lee y se escribe
    -- entero, junto con el puerto, y nunca se consulta por VLAN sola.
    ADD COLUMN IF NOT EXISTS vlans_equipo JSONB,

    -- Cuántas ONTs con service-port vio el equipo en este puerto.
    ADD COLUMN IF NOT EXISTS onts_equipo INT,

    -- Cuándo se leyó. NULL = nunca se relevó, que NO es lo mismo que "no tiene
    -- nada": sin esta distinción un equipo sin relevar se vería igual que uno
    -- vacío, y alguien concluiría que no hay abonados.
    ADD COLUMN IF NOT EXISTS leido_at    TIMESTAMPTZ;

COMMENT ON COLUMN puertos_pon.vlans_equipo IS
    'Lo que el equipo tiene puesto en el puerto, leído de sus service-ports. Es la foto del último relevamiento, no el estado de ahora: leido_at dice de cuándo es.';

COMMENT ON COLUMN puertos_pon.leido_at IS
    'Cuándo se relevó este puerto contra el equipo. NULL significa nunca, que no es lo mismo que "está vacío".';
