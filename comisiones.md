Necesito que implementes en el sistema actual un **Motor de Comisiones e Incentivos Comerciales para vendedores**.

IMPORTANTE:

Antes de programar, revisa completamente la estructura que ya existe relacionada con:

* usuarios;
* vendedores;
* roles y permisos;
* clientes;
* prospectos;
* ventas;
* contratos;
* planes de Internet;
* promociones;
* pagos;
* instalaciones;
* técnicos;
* equipos/ONT;
* suspensiones;
* reactivaciones;
* bajas;
* cartera/cobranza.

NO cambies el lenguaje, framework ni arquitectura que actualmente utiliza el sistema.

NO construyas módulos duplicados si ya existen funciones equivalentes.

Primero explícame qué partes del sistema actual vas a reutilizar, qué tablas/modelos necesitas modificar o crear y cómo integrarás esta funcionalidad. Luego procedemos con la implementación.

# 1. OBJETIVO

No quiero un sistema que simplemente pague una cantidad por cada contrato ingresado.

Quiero incentivar:

**CANTIDAD DE VENTAS + CALIDAD DE LAS VENTAS + PERMANENCIA DEL CLIENTE**

El vendedor debe ganar más cuando:

* vende más;
* vende planes de mayor valor;
* sus solicitudes son aprobadas;
* los clientes realmente se instalan;
* realizan su primer pago;
* permanecen como buenos clientes.

El sistema debe evitar incentivar el ingreso masivo de clientes de mala calidad únicamente para generar comisión.

---

# 2. TODO DEBE SER CONFIGURABLE POR SUPER ADMIN

NO quemar en código:

* porcentajes;
* cantidades;
* rangos;
* valores monetarios;
* bases comisionables;
* bonos;
* días;
* condiciones;
* períodos de evaluación.

Todas estas reglas deben almacenarse en base de datos y poder modificarse desde el panel Super Admin.

Debe existir:

**Configuración → Ventas → Comisiones e Incentivos**

---

# 3. BASE COMISIONABLE POR PLAN

Cada plan de Internet tendrá:

* precio comercial;
* precio sin impuestos;
* base comisionable;
* estado de comisión;
* vigencia.

Ejemplo inicial:

| Plan     | Precio comercial | Base comisionable |
| -------- | ---------------: | ----------------: |
| 50 Mbps  |           $20,00 |               $10 |
| 150 Mbps |           $23,10 |               $12 |
| 300 Mbps |           $25,70 |               $14 |
| 400 Mbps |           $30,00 |               $17 |
| 500 Mbps |           $35,00 |               $20 |

Estos valores NO son permanentes.

El Super Admin debe poder modificarlos.

La **base comisionable debe ser independiente del precio comercial y de las promociones**.

Ejemplo:

Plan 500 Mbps = $35.

Si existe una promoción del 50% durante tres meses, el cliente puede pagar temporalmente $17,50, pero la base comisionable puede continuar siendo $20 si así está configurada.

La promoción comercial NO debe modificar automáticamente la base comisionable.

---

# 4. ESCALONES DE COMISIÓN

Implementar inicialmente:

| Ventas válidas mensuales | Nivel   | Comisión |
| -----------------------: | ------- | -------: |
|                     1–10 | Inicial |      20% |
|                    11–15 | Bronce  |      30% |
|                    16–20 | Plata   |      35% |
|                    21–25 | Oro     |      40% |
|                    26–30 | Platino |      45% |
|                      31+ | Élite   |      50% |

Todos estos rangos, nombres y porcentajes deben ser configurables por Super Admin.

---

# 5. COMISIÓN RETROACTIVA POR NIVEL

Inicialmente utilizaremos el modelo:

**ESCALONADO RETROACTIVO**

Cuando el vendedor alcanza un nuevo nivel, el porcentaje alcanzado se aplica a todas las ventas válidas del período.

Ejemplo:

Base comisionable promedio = $14,60.

25 ventas:

$365 × 40% = $146.

Si llega a 26 ventas y alcanza 45%, el nuevo porcentaje se aplica a las 26 ventas válidas.

El sistema deberá recalcular automáticamente la comisión proyectada.

IMPORTANTE:

La configuración debe permitir que posteriormente podamos cambiar entre:

* retroactivo;
* progresivo por tramos;

sin reprogramar el motor.

---

# 6. DIFERENCIAR SOLICITUD DE VENTA Y VENTA COMISIONABLE

No considerar una solicitud ingresada como venta automáticamente.

El embudo debe distinguir:

**Prospecto**
→ **Solicitud**
→ **Validación**
→ **Aprobado**
→ **Contrato**
→ **Instalación**
→ **Activación**
→ **Primer pago**
→ **Venta comisionable**

Por lo tanto:

30 solicitudes ingresadas NO significan necesariamente 30 ventas.

El dashboard deberá mostrar ambas métricas.

---

# 7. VALIDACIÓN DEL CLIENTE

Antes de aprobar determinadas solicitudes existen controles internos de admisión.

El sistema debe permitir registrar:

**Pendiente de validación**

**Aprobado**

**Rechazado**

**Requiere revisión manual**

Las validaciones pueden incluir verificaciones autorizadas por la empresa, por ejemplo:

* política crediticia;
* validaciones documentales;
* controles internos;
* otras verificaciones permitidas y configuradas por administración.

IMPORTANTE:

El vendedor NO debe tener acceso innecesario a información sensible utilizada durante estas verificaciones.

El vendedor solamente necesita visualizar:

**En revisión**

**Aprobado**

**No aprobado**

**Requiere información adicional**

Los detalles internos deben quedar restringidos a roles autorizados.

Registrar auditoría de quién realizó la validación.

---

# 8. CUÁNDO SE GENERA LA COMISIÓN

La comisión NO debe generarse solamente porque el vendedor marque una oportunidad como "Ganada".

Debe existir una máquina de estados.

Ejemplo:

**Proyectada**
→ **Pendiente de validación**
→ **Generada**
→ **Aprobada**
→ **Pagada**

También:

**Anulada**

Inicialmente, para que una venta sea comisionable debe:

* estar aprobada;
* tener documentación requerida;
* tener contrato;
* estar instalada;
* estar activada;
* cumplir la condición de primer pago aplicable.

---

# 9. REGLA ESPECIAL PARA MODELO PREPAGO

El servicio funciona bajo modalidad prepago.

Normalmente el cliente debe pagar al momento de instalarse.

Sin embargo, existen instalaciones realizadas al final del mes que pueden tener un período de cortesía autorizado.

Por lo tanto, NO asumir que toda instalación sin pago inmediato es una mala venta.

Debe existir una configuración:

**Día de inicio del período de cortesía: 25**

Ejemplo:

Cliente instalado 27 de agosto.

27–31 agosto = período de cortesía autorizado.

Primer pago esperado = del 1 al 5 de septiembre.

La venta debe mostrarse como:

**Venta realizada / comisión pendiente de primer pago**

Cuando el cliente paga:

**Comisión confirmada**

Los días 25, 1–5 y demás fechas deben ser configurables.

---

# 10. CIERRE MENSUAL DE COMISIONES

Debido al período de cortesía, NO cerrar automáticamente la comisión el último día del mes.

Ejemplo:

Ventas de agosto.

Cierre definitivo: después del período de pago autorizado de septiembre.

El Super Admin debe poder configurar:

**Día de cierre de comisión: 5**

Ejemplo:

25 ventas confirmadas.

3 ventas instaladas desde el día 25 pendientes de primer pago.

Mostrar:

**Ventas confirmadas: 25**

**Pendientes de validación: 3**

**Ventas comerciales realizadas: 28**

Cuando finalice la ventana de pago se determina el nivel definitivo.

---

# 11. NO DESCONTAR AUTOMÁTICAMENTE COMISIONES YA GANADAS

Una vez que una comisión haya sido:

**Aprobada / Pagada**

NO debe reducirse automáticamente porque posteriormente el cliente deje de consumir.

Las bajas posteriores afectarán indicadores de calidad y bonos, no la comisión comercial ya cerrada.

Excepciones como fraude, duplicidad, manipulación o incumplimientos deberán gestionarse mediante un proceso administrativo autorizado y auditable, nunca mediante modificaciones silenciosas del sistema.

---

# 12. CLIENTES QUE NO RENUEVAN

Debido al modelo prepago:

**1 período sin pago:**

Estado:

**Suspendido por falta de renovación**

Debe aparecer al vendedor como oportunidad de recuperación.

Ejemplo:

"4 clientes de tu cartera no han renovado."

Permitir:

* contactar;
* registrar gestión;
* programar seguimiento;
* marcar resultado.

**2 meses consecutivos sin pago:**

El cliente debe pasar a:

**RETIRO DE EQUIPO**

Generar automáticamente una alerta/orden para el proceso correspondiente.

Los períodos deben ser configurables.

---

# 13. RECUPERACIÓN DE ONT

Cuando un cliente alcance la condición de retiro:

Generar seguimiento del equipo.

Registrar:

* cliente;
* ONT/equipo;
* serial;
* valor del equipo;
* fecha de instalación;
* fecha del último pago;
* fecha de suspensión;
* fecha de orden de retiro;
* técnico asignado;
* intentos de recuperación;
* evidencia;
* equipo recuperado;
* equipo no recuperado;
* motivo;
* observaciones.

NO descontar automáticamente el valor de una ONT perdida al vendedor.

El sistema debe permitir medir:

**Tasa de recuperación de equipos**

**ONT pendientes**

**ONT recuperadas**

**ONT no recuperadas**

**Valor económico en riesgo**

Ejemplo:

8 ONT pendientes × $50 = $400 en activos pendientes de recuperación.

---

# 14. REACTIVACIONES

Una reactivación NO debe contabilizarse como una venta nueva.

Si un cliente deja de consumir y posteriormente vuelve a pagar:

**REACTIVACIÓN**

No:

**NUEVA VENTA**

Debe conservarse el vendedor originalmente asociado cuando corresponda.

En el futuro podremos crear un incentivo independiente de recuperación/reactivación.

Preparar el modelo para soportarlo, pero NO mezclarlo con la comisión de venta nueva.

---

# 15. BONO DE CALIDAD

Además de la comisión comercial, implementar:

**BONO DE CALIDAD DE CARTERA**

Valor máximo inicial:

**$50**

Debe ser configurable.

Ejemplo inicial:

|   Calidad | Bono |
| --------: | ---: |
|      <70% |   $0 |
| 70–79,99% |  $10 |
| 80–84,99% |  $20 |
| 85–89,99% |  $30 |
| 90–94,99% |  $40 |
|   95–100% |  $50 |

También debe existir un mínimo configurable de clientes evaluables.

Ejemplo inicial:

**mínimo 10 clientes.**

---

# 16. CALIDAD POR COHORTES

NO mezclar clientes de diferentes meses.

Cada grupo de ventas deberá pertenecer a una:

**COHORTE COMERCIAL**

Ejemplo:

**Cohorte agosto 2026**

25 clientes comisionables.

El sistema realiza seguimiento durante un período configurable.

Inicialmente:

**90 días.**

Al finalizar se calcula la calidad de esa cohorte.

Ejemplo:

25 clientes evaluados.

23 mantienen comportamiento aceptable.

2 llegaron a condición de retiro.

Calidad:

23 / 25 = 92%

Bono:

**$40**

Una vez cerrado el bono de esa cohorte, una reactivación posterior NO debe modificar retroactivamente el bono cerrado.

---

# 17. DEFINICIÓN DE CALIDAD

No considerar automáticamente un mes sin consumo como pérdida del cliente.

Debido al modelo prepago, el cliente puede dejar de consumir un período y posteriormente reactivar.

Inicialmente considerar una señal negativa fuerte cuando alcance:

**2 meses consecutivos sin pago / condición de retiro de equipo.**

Además, permitir clasificar causas de baja.

Ejemplos que podrían NO perjudicar al vendedor:

* problemas técnicos atribuibles a la empresa;
* mudanza fuera de cobertura;
* fuerza mayor;
* error administrativo;
* otras causas autorizadas.

Ejemplos que pueden afectar calidad:

* abandono temprano;
* nunca realizó pago requerido;
* documentación irregular;
* incumplimiento de política comercial;
* otras causas configurables.

Estas causas deben poder configurarse desde administración.

---

# 18. KPI DE CALIDAD POR VENDEDOR

Calcular como mínimo:

**Solicitudes ingresadas**

**Tasa de aprobación**

**Ventas instaladas**

**Primer pago exitoso**

**Ventas comisionables**

**Tasa de conversión de calidad**

**Retención por cohorte**

**Clientes con 1 mes sin pago**

**Clientes en retiro**

**Reactivaciones**

**Bajas tempranas**

NO utilizar estos indicadores para realizar descuentos automáticos.

Servirán para gestión, análisis, bonos y detección de patrones.

---

# 19. DETECCIÓN DE PATRONES

El Super Admin debe poder comparar vendedores.

Ejemplo:

VENDEDOR A

Solicitudes: 32

Aprobadas: 29

Instaladas: 27

Primer pago: 26

Retención 90 días: 94%

VENDEDOR B

Solicitudes: 48

Aprobadas: 31

Instaladas: 29

Primer pago: 22

Retención 90 días: 71%

Esto permite identificar vendedores que ingresan muchas solicitudes pero generan clientes de baja calidad.

No realizar sanciones automáticas.

Solo mostrar información para decisión administrativa.

---

# 20. DASHBOARD DEL VENDEDOR

Crear una sección visual y motivadora:

## MI COMISIÓN

Ejemplo:

**24 ventas válidas**

**Nivel actual: ORO — 40%**

**Comisión proyectada: $140,16**

🔥 **Te faltan 2 ventas para llegar a PLATINO — 45%**

Mostrar:

**Si consigues 2 ventas válidas más:**

Comisión estimada: **$170,82**

Incremento potencial:

**+$30,66**

Utilizar una barra de progreso:

████████████████░░░

**24 / 26**

El objetivo es motivar al vendedor a conseguir la siguiente venta.

---

# 21. DASHBOARD DE CALIDAD DEL VENDEDOR

Agregar:

## CALIDAD DE MIS VENTAS

Ejemplo:

**Cohorte evaluada: Mayo**

Clientes evaluados: 25

Clientes conservados: 23

Calidad: **92%**

Bono proyectado:

**$40**

🔥 "Mantén 95% o más para alcanzar el bono máximo de $50."

Mostrar también:

**Clientes que requieren atención**

4 clientes con 1 mes sin renovación.

Botón:

**Gestionar cartera**

---

# 22. NO MOSTRAR RANKING COMPETITIVO OBLIGATORIO

No quiero que el dashboard se base únicamente en comparar empleados.

Priorizar:

**progreso individual**

**meta personal**

**siguiente nivel**

**calidad**

**comisión potencial**

El Super Admin sí podrá comparar vendedores para gestión interna.

---

# 23. DASHBOARD DEL SUPER ADMIN

Crear sección:

## INTELIGENCIA COMERCIAL

Mostrar:

* solicitudes;
* aprobaciones;
* rechazos;
* instalaciones;
* ventas comisionables;
* ventas por plan;
* ticket promedio;
* comisiones proyectadas;
* comisiones generadas;
* comisiones aprobadas;
* comisiones pagadas;
* bonos;
* calidad por vendedor;
* retención;
* bajas tempranas;
* reactivaciones;
* clientes con 1 mes sin pago;
* clientes con 2 meses sin pago;
* ONT pendientes;
* ONT recuperadas;
* ONT no recuperadas;
* valor económico de equipos en riesgo.

---

# 24. SIMULADOR PARA SUPER ADMIN

Quiero una herramienta:

**SIMULADOR DE COMISIONES**

Poder cambiar temporalmente:

* bases comisionables;
* porcentajes;
* rangos;
* número de vendedores;
* número de ventas;
* mezcla de planes;
* bono máximo;
* niveles de calidad.

Mostrar inmediatamente:

**Comisión por vendedor**

**Costo comercial total**

**Costo promedio por cliente adquirido**

**Bonos estimados**

**Costo total de incentivos**

El simulador NO debe modificar la configuración real hasta que el Super Admin pulse explícitamente:

**Aplicar configuración**

---

# 25. HISTÓRICO Y VERSIONADO

Las configuraciones deben tener vigencia.

Ejemplo:

**Plan de comisiones 2026-V1**

Vigencia:

01/08/2026 – 31/12/2026

Si posteriormente cambio las reglas, crear una nueva versión.

NO modificar períodos históricos.

Una comisión pagada debe conservar:

* base utilizada;
* porcentaje;
* nivel;
* reglas;
* vendedor;
* cliente;
* plan;
* fecha;
* valor;
* versión de configuración.

---

# 26. AUDITORÍA

Registrar:

* quién creó una regla;
* quién la modificó;
* fecha;
* valor anterior;
* valor nuevo;
* quién aprobó comisión;
* quién anuló;
* motivo;
* quién cerró el período;
* quién realizó validaciones sensibles.

Nada financiero debe modificarse silenciosamente.

---

# 27. PERMISOS

SUPER ADMIN:

Acceso completo a configuración, simulación, reportes y auditoría.

VENDEDOR:

Solo su cartera, ventas, comisiones, progreso y clientes asignados.

JEFE COMERCIAL, si existe:

Acceso según permisos asignados.

TÉCNICOS:

No deben visualizar información financiera del vendedor salvo que exista permiso explícito.

Mantener el sistema actual de roles y permisos.

---

# 28. PROTECCIÓN DE DATOS

No permitir al vendedor exportar masivamente la base de clientes.

Limitar su acceso a la cartera asignada y al período autorizado por administración.

Información sensible de validación crediticia, judicial u otras verificaciones debe tener permisos separados.

Registrar accesos cuando corresponda.

---

# 29. ESTADOS VISUALES

Utilizar estados claros:

🟢 Aprobada

🟡 Pendiente

🔵 Proyectada

🟣 Comisión generada

⚫ Pagada

🔴 Anulada

No depender exclusivamente de colores; incluir texto/iconografía accesible.

---

# 30. NO PROGRAMAR TODO A CIEGAS

Antes de escribir migraciones o modificar modelos:

1. Analiza el código existente.
2. Identifica qué funcionalidades ya existen.
3. Identifica qué modelos pueden reutilizarse.
4. Identifica integraciones necesarias.
5. Propón arquitectura.
6. Indícame posibles riesgos.
7. Muéstrame qué tablas/modelos piensas crear/modificar.
8. Explica el motor de cálculo.
9. Explica cómo evitarás duplicidad de comisiones.
10. Explica cómo manejarás cierres y versionado histórico.

Después de que yo apruebe esa propuesta, empezamos la implementación por fases.

NO intentes implementar todo en una sola respuesta.

Quiero desarrollar por fases:

**FASE 1:** modelos, configuración y permisos.

**FASE 2:** motor de cálculo de comisiones.

**FASE 3:** validación de ventas y cierre mensual.

**FASE 4:** bono de calidad y cohortes de 90 días.

**FASE 5:** cartera, reactivaciones y retiro de ONT.

**FASE 6:** dashboard vendedor.

**FASE 7:** inteligencia comercial Super Admin.

**FASE 8:** simulador de comisiones.

**FASE 9:** auditoría, pruebas y validación final.

Antes de comenzar la FASE 1, entrégame únicamente el análisis de arquitectura y el plan de implementación para mi aprobación.
