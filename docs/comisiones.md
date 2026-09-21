# Motor de comisiones e incentivos

Guía de puesta en marcha y verificación. Lo que sigue es el orden en que hay que
hacer las cosas y, sobre todo, **qué mirar después de cada paso** para saber si
salió bien.

El módulo está construido para que nada financiero se mueva solo: las tareas
automáticas vienen apagadas, el cierre no paga nada por su cuenta y toda
autorización queda con nombre y fecha.

---

## 1. Las migraciones, en orden

Se ejecutan en el **SQL Editor** de Supabase, una por una y en este orden. Todas
son idempotentes: volver a correr una no rompe nada ni pisa valores ya ajustados.

| # | Archivo | Qué deja andando |
|---|---|---|
| 97 | `migracion-97-comisiones-configuracion.sql` | Esquema versionado: bases por plan, escalones, bonos, reglas del período y motivos de baja. **No calcula nada todavía.** |
| 98 | `migracion-98-comisiones-motor.sql` | `comision_ventas` y el generador de hitos. El sistema ya sabe calcular una comisión, pero no puede pagarla. |
| 99 | `migracion-99-comisiones-validacion-cierre.sql` | Admisión de solicitudes, cierre mensual, aprobar / pagar / anular. |
| 100 | `migracion-100-comisiones-cohortes-y-bono.sql` | Motivo de baja en la ficha, veredicto de calidad por venta, cohortes y bono. |
| 101 | `migracion-101-cartera-retiros-y-reactivaciones.sql` | Órdenes de retiro de equipo, reactivaciones y cartera en riesgo. |
| 102 | `migracion-102-comision-real-en-el-tablero.sql` | El tablero comercial deja de estimar la comisión con un porcentaje fijo. |
| 103 | `migracion-103-inteligencia-comercial.sql` | Los indicadores del Super Admin y la comparación entre vendedores. |
| 104 | `migracion-104-auditoria-y-verificacion.sql` | Auditoría por disparador y la revisión del módulo. |

Después de la última:

```sql
SELECT res_prueba, res_estado, res_casos, res_detalle FROM verificar_comisiones();
```

Sobre una base recién migrada tienen que dar todas `ok`, salvo la del esquema
vigente si nadie cargó uno todavía.

---

## 2. Configurar antes de encender nada

**Ajustes → Comisiones e incentivos.**

La migración 97 carga los valores del requerimiento —los escalones del 20 % al
50 %, el bono hasta $50, el cierre el día 5— pero las **bases por plan** son las
que hay que revisar sí o sí: son la mitad de lo que se paga.

**El esquema arranca vigente desde el primer día del mes en que se instaló.** El
motor busca las reglas del día en que se ganó cada venta, así que lo vendido
antes de esa fecha queda fuera: no genera comisión y tampoco aparece en pantalla.
Es correcto —no se aplican reglas que nadie había definido a un mes ya cerrado—
pero conviene saberlo el primer mes. La prueba 13 de la revisión cuenta
exactamente cuántas ventas quedaron afuera; si tienen que comisionar, se crea una
versión con `vigente_desde` anterior.

Los seis interruptores de requisito arrancan exigiendo **instalación y
activación**. Es a propósito: si desde el día uno se exigiera contrato firmado y
primer pago sobre tablas que todavía están vacías, ninguna venta llegaría nunca a
comisionable y todos los vendedores verían cero para siempre, sin ningún mensaje
que lo explicara. Se encienden a medida que facturación y admisión entran en
régimen.

Antes de cambiar porcentajes conviene pasar por el **simulador**
(botón *Simulador* en esa misma pantalla): corre el escenario real del mes contra
las reglas nuevas y muestra la diferencia de costo. Aplicar desde ahí crea una
versión nueva; no reescribe lo ya pagado.

---

## 3. Encender las tareas

**Ajustes → Tareas programadas.** Las dos vienen apagadas.

- **Comisiones: refresco y cierre mensual** (03:30). Refresca los hitos de cada
  venta, mide las cohortes y, el día de cierre configurado, congela el mes
  anterior por vendedor. *Encenderla es lo que hace que el sistema empiece a
  fijar lo que se le va a pagar a alguien.*
- **Cartera: retiros de equipo y reactivaciones** (04:00). Abre las órdenes de
  retiro de quien llegó a la condición configurada y anota a los que volvieron a
  pagar. No mueve plata; genera trabajo de campo.

Se pueden encender por separado a propósito: una congela dinero y la otra no.

---

## 4. Los permisos

| Clave | Para qué |
|---|---|
| `comisiones.ver_propias` | Lo que necesita el vendedor: su comisión, su nivel y su progreso. |
| `comisiones.ver_todas` | Ver al equipo completo. Es información salarial de otras personas. |
| `comisiones.configurar` | Editar bases, escalones, bonos y reglas. |
| `comisiones.aprobar` / `comisiones.pagar` | Separados a propósito: conviene que quien autoriza el gasto no sea quien lo ejecuta. |
| `comisiones.anular` | Anular una comisión, siempre con motivo escrito. |
| `comisiones.simular` | Probar escenarios sin tocar la configuración. |
| `ventas.validar` / `ventas.validacion_sensible` | Decidir una admisión / ver el motivo interno de esa decisión. |
| `retiros.gestionar` | Asignar y cerrar órdenes de retiro de equipo. |

El rol **Vendedor** ya trae `comisiones.ver_propias`; **Bodega** y **Jefe
técnico**, `retiros.gestionar`.

---

## 5. Las pantallas

| Pantalla | Quién | Qué contesta |
|---|---|---|
| Comercial → **Mi comisión** | vendedor | Cuánto llevo, qué me falta para el escalón siguiente, qué ventas me cuentan y por qué, cómo va la calidad de mi cartera. |
| Reportes → **Comisiones del equipo** | admin | Cuánto cuesta el canal, quién trae buenos clientes, qué hay que autorizar. |
| Inventario → **Retiros de equipo** | bodega / campo | Qué equipos hay que ir a buscar y cómo terminó cada intento. |
| Ajustes → **Comisiones e incentivos** | super admin | Las reglas, las versiones, la revisión y la auditoría. |
| Ajustes → **Simulador** | super admin | Qué pasaría si las reglas fueran otras. |

---

## 6. Cómo verificar que funciona

**Las migraciones, antes de tocar la base del cliente:**

```bash
cd supabase/pruebas && npm install && npm test
```

Aplica las 107 sobre un Postgres real en memoria, comprueba que las 8 del módulo
se puedan volver a correr, ejecuta todas las funciones y hace pasar una venta por
el circuito entero. Tarda unos tres segundos.

**El cálculo del navegador** (lo que ve el vendedor mientras vende):

```bash
cd middleware && node --test test/comisionesCalculo.test.js
```

Verifica contra los ejemplos del requerimiento: 25 ventas al 40 % son $146, la
venta 26 sube el porcentaje de todas y da $170,82, el salto vale +$30,66, y una
cohorte de 23 sobre 25 paga bono de $40.

**El motor de la base** (lo que se paga de verdad):

```sql
SELECT * FROM generar_comisiones();
SELECT vendedor, periodo, ventas_validas, nivel, porcentaje, monto
  FROM v_comision_resumen ORDER BY periodo DESC;

SELECT res_prueba, res_estado, res_casos, res_detalle FROM verificar_comisiones();
```

La prueba número 3 de esa revisión es la que importa: recalcula **cada período
cerrado** con el motor y avisa si alguno no coincide con lo que se congeló.

**Que la auditoría no se pueda saltear:**

```sql
UPDATE comision_niveles SET porcentaje = porcentaje + 1
 WHERE id = (SELECT id FROM comision_niveles LIMIT 1);

SELECT creado_en, usuario_nombre, descripcion, campos
  FROM v_auditoria_comisiones ORDER BY creado_en DESC LIMIT 3;

UPDATE comision_niveles SET porcentaje = porcentaje - 1
 WHERE id = (SELECT id FROM comision_niveles LIMIT 1);
```

Tienen que aparecer los dos cambios con el valor anterior y el nuevo, sin que
nadie los haya anotado a mano.

---

## 7. Lo que el sistema NO hace, a propósito

Está escrito acá porque son decisiones, no olvidos:

- **No descuenta nada a nadie automáticamente.** Ni el valor de una ONT perdida,
  ni una comisión ya aprobada porque el cliente después se dio de baja. Las bajas
  afectan bonos de calidad futuros; lo cerrado no se toca.
- **No paga por marcar un prospecto como ganado.** Una venta comisiona cuando
  cumple los requisitos configurados, y el vendedor ve exactamente cuál le falta.
- **No cuenta una reactivación como venta nueva.** Se registra aparte, para el
  incentivo de recuperación que todavía no existe.
- **No recalcula un período aprobado.** Ni el cierre, ni el generador, ni la
  tarea de la noche.
- **No compara vendedores en la pantalla del vendedor.** Esa comparación existe,
  pero es una herramienta de gestión y vive en la pantalla del administrador.
