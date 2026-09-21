# Análisis y Estructura del Proyecto: Sistema Web de Gestión OLT/MikroTik (Estilo SmartOLT)

> Documento original del taller, convertido desde `smart.md.docx` a Markdown versionable.

Para un taller práctico o de aprendizaje, desarrollar una plataforma con alcance similar a
SmartOLT requiere dividir la complejidad en módulos independientes. A continuación, el análisis
técnico y la arquitectura recomendada utilizando tecnologías modernas y de rápido despliegue
(React/Vite, Supabase y un servicio intermedio para las integraciones de red).

---

## 1. Arquitectura del Sistema

Debido a que el navegador web no puede comunicarse directamente vía SSH, Telnet o la API Socket
de MikroTik/OLT por restricciones de seguridad y protocolos, la arquitectura debe contar con un
**Backend de Integración (API Middleware)**.

```
+-------------------------------------------------------+
|                    FRONTEND (Web)                     |
|           React / Vite + Tailwind CSS                 |
+--------------------------+----------------------------+
                           |
            +--------------+--------------+
            |                             |
            v                             v
+-----------------------+     +-------------------------+
|   SUPABASE (Backend)  |     |   API MIDDLEWARE (Red)  |
|  - Auth (Usuarios)    |     |  - RouterOS REST API    |
|  - PostgreSQL (DB)    |     |  - SSH / Telnet OLT     |
|  - Row Level Security |     |  - SNMP (Estadísticas)  |
+-----------------------+     +-------------------------+
```

---

## 2. Tecnologías Recomendadas

- **Frontend Web**: React (con Vite) + Tailwind CSS + Lucide Icons.
- **Base de Datos y Autenticación**: Supabase (PostgreSQL autohospedado o cloud).
- **Backend de Integración / Agent**: Node.js (Express/Fastify) o Python (FastAPI).
- **Librerías clave**:
  - MikroTik: REST API de RouterOS v7 (`fetch`), o `@node-routeros/api` / `librouteros` para la API binaria.
  - OLT (V-SOL / Huawei): `ssh2` (Node.js) o `paramiko` / `netmiko` (Python).
- **Métricas y Gráficos**: Recharts / Chart.js.

---

## 3. Estructura de la Base de Datos (Supabase)

```sql
-- 1. Tabla de OLTs
CREATE TABLE olts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL,
    marca VARCHAR(20) CHECK (marca IN ('Huawei', 'VSOL')),
    ip_host VARCHAR(45) NOT NULL,
    puerto_ssh INT DEFAULT 22,
    usuario VARCHAR(50) NOT NULL,
    password_encrypted TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabla de ONUs / ONT
CREATE TABLE onus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id UUID REFERENCES olts(id) ON DELETE CASCADE,
    sn VARCHAR(50) UNIQUE NOT NULL,
    nombre_cliente VARCHAR(150),
    frame INT DEFAULT 0,
    slot INT NOT NULL,
    puerto INT NOT NULL,
    onu_index INT NOT NULL,             -- Posición ID en la OLT
    plan_velocidad VARCHAR(50),
    estado VARCHAR(20) DEFAULT 'offline', -- online, offline, los
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Tabla de Routers MikroTik
CREATE TABLE routers_mikrotik (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100),
    ip_host VARCHAR(45) NOT NULL,
    puerto_api INT DEFAULT 8728,
    usuario VARCHAR(50) NOT NULL,
    password_encrypted TEXT NOT NULL
);

-- 4. Tipos de ONT / Modelos de ONU
CREATE TABLE tipos_ont (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    marca VARCHAR(50) NOT NULL,         -- Huawei, V-SOL, ZTE
    modelo VARCHAR(50) NOT NULL,
    puertos_ethernet INT DEFAULT 1,
    puertos_fxs INT DEFAULT 0,
    wifi BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Line Profiles (Perfiles de Línea OLT)
CREATE TABLE line_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id UUID REFERENCES olts(id) ON DELETE CASCADE,
    nombre VARCHAR(100) NOT NULL,
    vlan_id INT NOT NULL,
    gemport_id INT DEFAULT 1,
    profile_id_olt INT NOT NULL         -- ID numérico interno en la OLT
);

-- 6. Planes de Velocidad (Ancho de Banda / QoS)
CREATE TABLE planes_velocidad (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL,
    bajada_kbps INT NOT NULL,           -- ej. 100000 para 100M
    subida_kbps INT NOT NULL,           -- ej. 50000 para 50M
    burst_limit VARCHAR(50),            -- Opcional para MikroTik (ej. "120M/60M")
    precio NUMERIC(10,2) NOT NULL
);

-- 7. Asignación de IP Address (Pools y Estáticas)
CREATE TABLE ip_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    router_id UUID REFERENCES routers_mikrotik(id),
    ip_address VARCHAR(45) NOT NULL,
    netmask VARCHAR(15) DEFAULT '255.255.255.0',
    interfaz VARCHAR(50) NOT NULL,
    estado VARCHAR(20) DEFAULT 'libre'  -- libre, asignada, reservada
);

-- 8. Reglas de Firewall y Bloqueos de Servicio
CREATE TABLE firewall_bloqueos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    router_id UUID REFERENCES routers_mikrotik(id),
    cliente_ip VARCHAR(45) NOT NULL,
    mac_address VARCHAR(17),
    tipo_accion VARCHAR(20) CHECK (tipo_accion IN ('CORTAR_SERVICIO', 'REDIRECCION_PAGO', 'DROP_FORWARD')),
    comentario TEXT,
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## 4. Estructura del Proyecto Web (Frontend)

```
src/
├── components/
│   ├── layout/
│   │   ├── Sidebar.jsx            # Menú de navegación principal
│   │   ├── Navbar.jsx             # Perfil de usuario y estado
│   │
│   ├── mikrotik/                  # MÓDULO MIKROTIK
│   │   ├── IPPoolManager.jsx      # Crear / Listar Pools de IP
│   │   ├── IPAddressManager.jsx   # Listado y asignación de IPs por Interfaz
│   │   ├── FirewallRules.jsx      # Reglas de Filter & NAT
│   │   ├── BloqueosManager.jsx    # Gestión de cortes morosos / listas de bloqueo
│   │
│   ├── olt/                       # MÓDULO OLT / GPON
│   │   ├── OLTForm.jsx            # Registro de OLT (Huawei / V-SOL)
│   │   ├── TiposONTManager.jsx    # Catálogo de modelos de ONT/ONU
│   │   ├── LineProfileForm.jsx    # Asignación de VLANs y Line Profiles
│   │   ├── PlanesVelocidad.jsx    # Configuración de Queues / Traffic Profiles
│   │   ├── UnconfiguredONUs.jsx   # Detección de ONUs no autorizadas
│   │   ├── ONUStatsCard.jsx       # Señal óptica (Rx/Tx), distancias
│   │
│   ├── onus/                      # GESTIÓN DE ONUS
│   │   ├── ONUProvisionForm.jsx   # Vincula: Cliente + ONT Type + LineProfile + Plan
│   │   ├── ONUBloqueoCard.jsx     # Deshabilitación lógica o puerto en OLT
│
├── pages/
│   ├── Dashboard.jsx              # Resumen global de la red
│   ├── MikrotikPage.jsx           # Gestión de Routers
│   ├── OLTPage.jsx                # Gestión de OLTs y ONUs
│   ├── Login.jsx                  # Autenticación Supabase
│
├── lib/
│   ├── supabaseClient.js          # Configuración de cliente Supabase
│   ├── apiNetwork.js              # Llamadas a la API Middleware
```

---

## 5. Módulos y Funcionalidades Principales

### Módulo MikroTik (Red IP, Firewall y Bloqueos)

**IP Pools / IP Addresses**

- Crear pools dinámicos/estáticos a través de la API RouterOS (`/ip/pool/add`).
- Consultar direcciones IP asignadas y disponibles en tiempo real.
- Administrar interfaces (ej. `ether1`, `vlan10`) e IPs de gateway para las ONUs
  (`/ip/address/add`, `/ip/address/print`).

**Firewall & Bloqueos (Corte de Servicio)**

- **Corte por Address-List**: agrega la IP/MAC del cliente a una lista de morosos
  (`/ip/firewall/address-list/add list=CORTE_MOROSOS`).
- **Redirección de Pago**: regla NAT (`/ip/firewall/nat`) que redirige todo el tráfico HTTP de
  la lista `CORTE_MOROSOS` hacia una página local de aviso de pago.

### Módulo OLT (Huawei & V-SOL)

**Aprovisionamiento de ONUs**

- Huawei (CLI vía SSH/Telnet): `ont add`, `ont ipconfig`, `service-port`.
- V-SOL: comandos CLI o SNMP específicos del modelo.

**Descubrimiento Automático**

- Escaneo de ONUs en estado `unconfigured` / `autofind` en la OLT.

**Eliminación y Desautorización**

- `ont delete` y eliminación de puertos de servicio asociados en cascada.

**Estadísticas y Telemetría**

- Lectura de potencia óptica (Rx/Tx Power) expresada en dBm.
- Estado operacional (Online, WireDown, PowerFee/LOS).
- Distancia del cable (en metros).

**Tipos de ONT & Line Profiles**

Al registrar una ONU se selecciona su Tipo de ONT (para definir los puertos Ethernet/WiFi) y su
Line Profile (para etiquetar la VLAN correspondiente en la OLT).

```bash
ont-lineprofile gpon profile-name "PROFILE_VLAN100"
 vlan-map 1 100
```

**Planes de Velocidad (Traffic Profiles)**

El plan de velocidad crea un DBA Profile / Traffic Profile en la OLT (para control físico en la
fibra) y opcionalmente un Simple Queue o PPPoE Secret en el MikroTik.

```bash
traffic table ip index 10 name "PLAN_100M" cir 10240 pir 102400 priority 6
```

---

## 6. Hoja de Ruta para el Taller Práctico

### Fase 1: Configuración de Base de Datos e Interfaz (1-2 horas)

- Configurar proyecto en Supabase (Auth + Tablas SQL).
- Crear el Layout Web con el menú lateral de navegación.

### Fase 2: Integración MikroTik (2 horas)

- Crear endpoint en la API Middleware para conectar con MikroTik.
- Probar la creación de un IP Pool desde la interfaz web.

### Fase 3: Integración OLT y ONUs (3-4 horas)

- Crear plantillas de comandos SSH para OLT Huawei y V-SOL.
- Diseñar el flujo de aprovisionamiento de una ONU:
  Detectar → Seleccionar Perfil/VLAN → Registrar en OLT → Guardar en Supabase.

### Fase 4: Panel de Métricas (1 hora)

- Consultar potencia de la ONU en tiempo real y mostrar alertas si la potencia cae por debajo
  de **-27 dBm**.

---

## Checkpoint de Fase 1

- [ ] Las 8 tablas existen en Supabase con RLS activado.
- [ ] Login funciona con el usuario de prueba y redirige al Dashboard.
- [ ] Sidebar/Navbar visibles y con navegación entre páginas.
- [ ] Se puede crear una fila de prueba en `olts` desde la UI y verla listada (y confirmarla
      también en Supabase Table Editor).
- [ ] Intentar leer `olts` **sin** estar autenticado falla (prueba rápida de que RLS está
      protegiendo los datos).
