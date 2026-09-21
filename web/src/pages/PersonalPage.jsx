import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import {
  Check,
  History,
  KeyRound,
  Pencil,
  Plug,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  UserCog,
  UserX,
  Users,
} from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  SkeletonTabla,
  Stat,
  Table,
  Tabs,
} from '../components/ui'
import { personalApi } from '../lib/personal'
import { api } from '../lib/apiNetwork'
import { supabase } from '../lib/supabaseClient'
import {
  GRUPOS_PERMISOS,
  ROLES,
  TODO,
  buscarRol,
  nombreRol,
  permisosDeRol,
  puedeEditarA,
  rolesAsignablesPor,
  diferenciaConElRol,
  nombrePermiso,
} from '../lib/permisos'
import { usePermisos } from '../lib/AuthContext'

/**
 * Gestión de personal: quién entra al sistema y qué puede tocar.
 *
 * ── Por qué el rol y los permisos conviven en la misma ficha ──
 *
 * Se evaluó separarlos en dos pantallas —"roles" por un lado, "usuarios" por
 * otro— como hacen casi todos. Se descartó: en un ISP chico los roles no se
 * diseñan una vez y se reutilizan, se ajustan por persona. El cobrador de la
 * mañana y el de la tarde no hacen lo mismo. Obligar a crear un rol nuevo para
 * cada matiz termina en una lista de veinte roles que nadie entiende.
 *
 * Acá el rol es una plantilla que marca los checkboxes recomendados, y desde
 * ahí se ajusta. Lo que se guarda es la lista de permisos, no el rol.
 */

const VACIO = {
  nombre: '',
  apellido: '',
  usuario: '',
  email: '',
  celular: '',
  clave: '',
  rol: 'tecnico',
  activo: true,
  todas_las_zonas: false,
  dos_factores: false,
  permisos: permisosDeRol('tecnico'),
}

const fecha = (v) =>
  v
    ? new Date(v).toLocaleString('es-EC', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

/**
 * Avisa cuando esta persona no coincide con el molde de su rol.
 *
 * ── Por qué es necesario ──
 *
 * Los permisos se copian del rol al crear al usuario y después viven en su
 * ficha. Cambiar el rol NO cambia a quien ya existía.
 *
 * Eso ya costó caro: se le sacó al Vendedor la pantalla de Planes porque no le
 * servía, y la vendedora que ya estaba cargada la siguió viendo. El molde decía
 * una cosa y la realidad otra, sin un solo aviso en ningún lado.
 *
 * No dice "error": ajustar a una persona es legítimo y frecuente. Dice que hay
 * una diferencia, para que sea una decisión y no un descuido. El detalle va en
 * el `title` porque en la fila no entra y porque el número es lo que hace mirar.
 */
function FueraDelMolde({ usuario }) {
  const { de_mas, de_menos } = diferenciaConElRol(usuario)
  if (!de_mas.length && !de_menos.length) return null

  const detalle = [
    de_mas.length && `De más:\n${de_mas.map((c) => `· ${nombrePermiso(c)}`).join('\n')}`,
    de_menos.length && `Le falta del rol:\n${de_menos.map((c) => `· ${nombrePermiso(c)}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  return (
    <div className="mt-1 text-[10px] text-amber-400/80" title={detalle}>
      {de_mas.length > 0 && `${de_mas.length} de más`}
      {de_mas.length > 0 && de_menos.length > 0 && ' · '}
      {de_menos.length > 0 && `${de_menos.length} de menos`}
    </div>
  )
}

/** Un checkbox con su etiqueta y su nota, que es lo que se repite en toda la ficha. */
function Casilla({ marcado, onCambiar, deshabilitado, children, nota }) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
        deshabilitado ? 'opacity-40' : 'cursor-pointer hover:bg-slate-800/50'
      }`}
    >
      <input
        type="checkbox"
        checked={marcado}
        disabled={deshabilitado}
        onChange={(e) => onCambiar(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
      />
      <span>
        <span className="text-slate-200">{children}</span>
        {nota && <span className="block text-[11px] leading-tight text-slate-500">{nota}</span>}
      </span>
    </label>
  )
}

export default function PersonalPage() {
  const confirmar = useConfirmar()
  const { puede, perfil, rol: miRol, esSuperAdmin } = usePermisos()

  const [usuarios, setUsuarios] = useState([])
  const [auditoria, setAuditoria] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('usuarios')
  const [busqueda, setBusqueda] = useState('')
  const [filtroRol, setFiltroRol] = useState('')

  const [editando, setEditando] = useState(null) // el formulario abierto
  const [guardando, setGuardando] = useState(false)
  const [claveDe, setClaveDe] = useState(null)
  // La llave recién generada vive solo acá: no se guarda y no se puede recuperar.
  const [apiDe, setApiDe] = useState(null)
  const [apiGenerada, setApiGenerada] = useState(null)
  const [historialDe, setHistorialDe] = useState(null)
  const [historial, setHistorial] = useState([])
  const [tecnicos, setTecnicos] = useState([])

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [lista, log, tec] = await Promise.all([
        personalApi.listar(),
        personalApi.auditoria({ limite: 300 }).catch(() => []),
        supabase.from('tecnicos').select('id, nombre').eq('activo', true).order('nombre'),
      ])
      setUsuarios(lista)
      setAuditoria(log)
      setTecnicos(tec?.data ?? [])
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return usuarios.filter((u) => {
      if (filtroRol && u.rol !== filtroRol) return false
      if (!q) return true
      return [u.nombre, u.apellido, u.usuario, u.email, u.celular]
        .filter(Boolean)
        .some((c) => String(c).toLowerCase().includes(q))
    })
  }, [usuarios, busqueda, filtroRol])

  const activos = usuarios.filter((u) => u.activo).length

  // ---------------------------------------------------------------------------
  // El formulario
  // ---------------------------------------------------------------------------
  const abrirNuevo = () => {
    // Se abre con el primer rol que este usuario puede asignar, no con uno fijo:
    // ofrecerle "Administrador" por defecto a quien no puede crearlo es proponer
    // algo que el servidor va a rechazar.
    const primero = rolesAsignablesPor(miRol ?? 'super_admin')[0]?.clave ?? 'tecnico'
    setEditando({ ...VACIO, rol: primero, permisos: permisosDeRol(primero) })
  }

  const abrirEdicion = (u) =>
    setEditando({ ...u, clave: '', permisos: Array.isArray(u.permisos) ? [...u.permisos] : [] })

  /**
   * Cambiar el rol repone los permisos de la plantilla.
   *
   * Se evaluó preservar lo que el administrador ya había tildado. Se descartó:
   * los permisos de un Cobrador no significan nada aplicados a un Bodeguero, y
   * conservarlos deja mezclas que nadie eligió. Se avisa en la ficha para que
   * no sorprenda.
   */
  const cambiarRol = (rol) => setEditando((e) => ({ ...e, rol, permisos: permisosDeRol(rol) }))

  const alternarPermiso = (clave, marcado) =>
    setEditando((e) => ({
      ...e,
      permisos: marcado ? [...new Set([...e.permisos, clave])] : e.permisos.filter((c) => c !== clave),
    }))

  const alternarGrupo = (grupo, marcado) => {
    const claves = grupo.permisos.filter((p) => !p.soloSuper || esSuperAdmin).map((p) => p.clave)
    setEditando((e) => ({
      ...e,
      permisos: marcado
        ? [...new Set([...e.permisos, ...claves])]
        : e.permisos.filter((c) => !claves.includes(c)),
    }))
  }

  const guardar = async () => {
    setGuardando(true)
    try {
      const { id, clave, ...datos } = editando
      if (id) await personalApi.editar(id, datos)
      else await personalApi.crear({ ...datos, clave })
      setEditando(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const cambiarEstado = async (u) => {
    try {
      await personalApi.editar(u.id, { activo: !u.activo })
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const eliminar = async (u) => {
    // El aviso nombra a la persona y su rol: "¿eliminar?" a secas se confirma
    // sin leer, y acá el error no se deshace.
    if (!await confirmar(`¿Eliminar a ${u.nombre} ${u.apellido} (${nombreRol(u.rol)})? No se puede deshacer.`)) return
    try {
      await personalApi.eliminar(u.id)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const verHistorial = async (u) => {
    setHistorialDe(u)
    setHistorial([])
    try {
      setHistorial(await personalApi.auditoria({ usuarioId: u.id, limite: 100 }))
    } catch (err) {
      setError(err)
    }
  }

  // Un usuario sin legajo (instalación que no corrió la migración) ve la
  // pantalla pero no puede escribir: el middleware se lo va a negar igual, y es
  // mejor que el botón lo diga antes que después.
  const sinLegajo = !perfil
  const puedeCrear = puede('usuarios.crear') && !sinLegajo
  const puedeEditar = puede('usuarios.editar') && !sinLegajo
  // La fila del dueño no muestra botones para nadie más: el servidor los va a
  // rechazar igual, y un botón que siempre falla enseña a ignorar los errores.
  const gestionable = (u) => puedeEditarA({ id: perfil?.id, rol: miRol ?? 'super_admin' }, u)

  if (!puede('usuarios.ver')) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Aviso tipo="alerta">No tenés permiso para ver la gestión de personal.</Aviso>
      </div>
    )
  }

  const rolActual = editando ? buscarRol(editando.rol) : null
  const esNuevo = editando && !editando.id
  // Editándose a uno mismo, el rol y los permisos ni se muestran: el servidor
  // los descarta. Dibujar checkboxes que no van a guardarse es peor que no
  // ofrecerlos — quien los tilda cree que quedó hecho.
  const editandoseASiMismo = Boolean(editando?.id && editando.id === perfil?.id)

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <UserCog size={20} className="text-sky-400" />
            Gestión de personal
          </h1>
          <p className="text-sm text-slate-400">
            Quién entra al sistema, con qué rol y qué puede tocar.
          </p>
        </div>
        {puedeCrear && (
          <Button onClick={abrirNuevo}>
            <Plus size={16} /> Nuevo usuario
          </Button>
        )}
      </div>

      {error && <ErrorBanner error={error} onCerrar={() => setError(null)} />}

      {sinLegajo && !cargando && (
        <Aviso tipo="alerta">
          Tu sesión no tiene un legajo de personal asociado, así que podés mirar pero no guardar.
          Corré la migración 66 en Supabase y pedile a un Super Administrador que te dé de alta.
        </Aviso>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Usuarios" valor={usuarios.length} icon={Users} />
        <Stat label="Activos" valor={activos} icon={ShieldCheck} color="text-emerald-400" />
        <Stat
          label="Inactivos"
          valor={usuarios.length - activos}
          icon={UserX}
          color="text-slate-400"
        />
        <Stat
          label="Con 2FA"
          valor={usuarios.filter((u) => u.dos_factores).length}
          icon={Shield}
          color="text-amber-400"
        />
      </div>

      <Tabs
        activa={tab}
        onCambiar={setTab}
        tabs={[
          { clave: 'usuarios', label: 'Usuarios', icon: Users, contador: usuarios.length },
          { clave: 'auditoria', label: 'Auditoría', icon: History, contador: auditoria.length },
        ]}
      />

      {tab === 'usuarios' && (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre, usuario, correo o celular"
                className="pl-9"
              />
            </div>
            {/* Sin el Super Administrador: no es un rol que se reparta, y
                ofrecerlo en una lista lo hace parecer uno más. El dueño se ve
                igual en el listado sin filtrar. */}
            <Select value={filtroRol} onChange={(e) => setFiltroRol(e.target.value)} className="w-48">
              <option value="">Todos los roles</option>
              {ROLES.filter((r) => r.clave !== 'super_admin').map((r) => (
                <option key={r.clave} value={r.clave}>
                  {r.nombre}
                </option>
              ))}
            </Select>
          </div>

          {cargando ? (
            <SkeletonTabla filas={6} columnas={6} />
          ) : (
            <Table
              columnas={['Usuario', 'Rol', 'Contacto', 'Estado', 'Último acceso', 'Creado', '']}
              filas={visibles}
              vacio="No hay usuarios que coincidan."
              renderFila={(u) => (
                <tr key={u.id} className="hover:bg-slate-800/40">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-100">
                      {u.nombre} {u.apellido}
                    </div>
                    <div className="text-[11px] text-slate-500">@{u.usuario}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge color={buscarRol(u.rol)?.color ?? 'gris'}>{nombreRol(u.rol)}</Badge>
                    {u.todas_las_zonas && (
                      <div className="mt-1 text-[10px] text-slate-500">todas las zonas</div>
                    )}
                    <FueraDelMolde usuario={u} />
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    <div>{u.email}</div>
                    <div className="text-[11px] text-slate-500">{u.celular || '—'}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge color={u.activo ? 'verde' : 'gris'}>{u.activo ? 'Activo' : 'Inactivo'}</Badge>
                    {u.dos_factores && (
                      <div className="mt-1 text-[10px] text-amber-400/80">2FA</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{fecha(u.ultimo_acceso)}</td>
                  <td className="px-3 py-2 text-slate-400">{fecha(u.creado_en)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variante="fantasma" onClick={() => verHistorial(u)} title="Historial de actividad">
                        <History size={15} />
                      </Button>
                      {/*
                        Generar la llave de API con los permisos de esta persona.
                        Va acá y no en Integraciones porque es el gesto que ya se
                        conoce: se elige a quien la pidió y se le entrega.
                      */}
                      {puede('config.integraciones') && u.activo && (
                        <Button
                          variante="fantasma"
                          onClick={() => setApiDe(u)}
                          title="Generar llave de API con sus permisos"
                        >
                          <Plug size={15} />
                        </Button>
                      )}
                      {puedeEditar && gestionable(u) && (
                        <>
                          <Button variante="fantasma" onClick={() => abrirEdicion(u)} title="Editar y permisos">
                            <Pencil size={15} />
                          </Button>
                          <Button variante="fantasma" onClick={() => setClaveDe(u)} title="Cambiar contraseña">
                            <KeyRound size={15} />
                          </Button>
                          <Button
                            variante="fantasma"
                            onClick={() => cambiarEstado(u)}
                            title={u.activo ? 'Desactivar' : 'Activar'}
                          >
                            {u.activo ? <UserX size={15} /> : <Check size={15} />}
                          </Button>
                        </>
                      )}
                      {puede('usuarios.eliminar') && gestionable(u) && u.id !== perfil?.id && (
                        <Button variante="peligro" onClick={() => eliminar(u)} title="Eliminar">
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            />
          )}
        </Card>
      )}

      {tab === 'auditoria' && (
        <Card
          title="Auditoría"
          subtitle="Quién hizo qué, cuándo y desde dónde. Solo se agrega: nadie puede editarla ni borrarla."
        >
          {cargando ? (
            <SkeletonTabla filas={8} columnas={4} />
          ) : (
            <Table
              columnas={['Fecha y hora', 'Usuario', 'Acción', 'IP']}
              filas={auditoria}
              vacio="Todavía no hay actividad registrada."
              renderFila={(a) => (
                <tr key={a.id} className="hover:bg-slate-800/40">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fecha(a.creado_en)}</td>
                  <td className="px-3 py-2">
                    <div className="text-slate-200">{a.usuario_nombre || '—'}</div>
                    <div className="text-[11px] text-slate-500">{nombreRol(a.usuario_rol)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-slate-200">{a.descripcion}</div>
                    <div className="text-[11px] text-slate-500">{a.accion}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{a.ip || '—'}</td>
                </tr>
              )}
            />
          )}
        </Card>
      )}

      {/* --------------------------------------------------------------------
          La ficha: datos, rol y permisos en una sola pantalla
         -------------------------------------------------------------------- */}
      <Modal
        abierto={!!editando}
        titulo={esNuevo ? 'Nuevo usuario' : `Editar a ${editando?.nombre ?? ''}`}
        onCerrar={() => setEditando(null)}
        ancho="max-w-4xl"
      >
        {editando && (
          <div className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Nombre">
                <Input
                  value={editando.nombre}
                  onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                />
              </Field>
              <Field label="Apellido">
                <Input
                  value={editando.apellido}
                  onChange={(e) => setEditando({ ...editando, apellido: e.target.value })}
                />
              </Field>
              <Field label="Usuario" hint="Con el que inicia sesión. No distingue mayúsculas.">
                <Input
                  value={editando.usuario}
                  onChange={(e) => setEditando({ ...editando, usuario: e.target.value })}
                />
              </Field>
              <Field label="Correo electrónico" hint="Es la credencial de acceso.">
                <Input
                  type="email"
                  value={editando.email}
                  onChange={(e) => setEditando({ ...editando, email: e.target.value })}
                />
              </Field>
              <Field
                label="Teléfono celular"
                hint="En un vendedor es además el número con el que firma sus mensajes al cliente. Sin esto, el cliente recibe un precio de un desconocido."
              >
                <Input
                  value={editando.celular ?? ''}
                  onChange={(e) => setEditando({ ...editando, celular: e.target.value })}
                  placeholder="09XXXXXXXX"
                />
              </Field>
              {esNuevo && (
                <Field label="Contraseña" hint="Mínimo 8 caracteres. Después se cambia desde la lista.">
                  <Input
                    type="password"
                    value={editando.clave}
                    onChange={(e) => setEditando({ ...editando, clave: e.target.value })}
                  />
                </Field>
              )}
            </div>

            {editandoseASiMismo ? (
              <Aviso tipo="alerta">
                Estás editando tu propio usuario: podés corregir tus datos y tu contraseña, pero no
                tu rol ni tus permisos. Nadie se amplía a sí mismo — eso lo hace otra persona.
              </Aviso>
            ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Rol" hint="Marca los permisos recomendados. Después se ajustan abajo.">
                <Select value={editando.rol} onChange={(e) => cambiarRol(e.target.value)}>
                  {rolesAsignablesPor(miRol ?? 'super_admin').map((r) => (
                    <option key={r.clave} value={r.clave}>
                      {r.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* El vínculo con el técnico ya cargado en Soporte. No es un dato
                  administrativo: es lo que decide qué tickets ve al entrar. Sin
                  elegirlo, su bandeja va a estar vacía. */}
              {editando.rol === 'tecnico' && (
                <Field
                  label="Técnico vinculado"
                  hint="De acá salen los tickets e instalaciones que va a ver. Sin esto no ve ninguno."
                >
                  <Select
                    value={editando.tecnico_id ?? ''}
                    onChange={(e) => setEditando({ ...editando, tecnico_id: e.target.value || null })}
                  >
                    <option value="">— sin vincular —</option>
                    {tecnicos.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.nombre}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="flex flex-col justify-end gap-1 pb-1">
                <Casilla
                  marcado={editando.activo}
                  onCambiar={(v) => setEditando({ ...editando, activo: v })}
                >
                  Estado activo
                </Casilla>
                <Casilla
                  marcado={editando.todas_las_zonas}
                  onCambiar={(v) => setEditando({ ...editando, todas_las_zonas: v })}
                >
                  Opera todas las zonas
                </Casilla>
                <Casilla
                  marcado={editando.dos_factores}
                  onCambiar={(v) => setEditando({ ...editando, dos_factores: v })}
                >
                  Autenticación de dos factores
                </Casilla>
              </div>
            </div>
            )}

            {/* Lo que el rol implica, en palabras. Elegir "Cobrador" sin saber
                qué deja de ver es cómo se termina con un cobrador que no puede
                trabajar y una llamada al soporte. */}
            {rolActual && !editandoseASiMismo && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                <p className="text-[13px] text-slate-300">{rolActual.resumen}</p>
                <div className="mt-2 grid gap-3 text-[12px] md:grid-cols-2">
                  <div>
                    <div className="mb-1 font-medium text-emerald-400">Puede</div>
                    <ul className="space-y-0.5 text-slate-400">
                      {rolActual.puede.map((p) => (
                        <li key={p}>· {p}</li>
                      ))}
                    </ul>
                  </div>
                  {rolActual.noPuede.length > 0 && (
                    <div>
                      <div className="mb-1 font-medium text-red-400">No puede</div>
                      <ul className="space-y-0.5 text-slate-400">
                        {rolActual.noPuede.map((p) => (
                          <li key={p}>· {p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className={editandoseASiMismo ? 'hidden' : ''}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-200">Permisos</h3>
                <button
                  type="button"
                  onClick={() => cambiarRol(editando.rol)}
                  className="text-[12px] text-sky-400 hover:text-sky-300"
                >
                  Restablecer los del rol
                </button>
              </div>

              {editando.permisos.includes(TODO) ? (
                <Aviso tipo="info">
                  El Super Administrador tiene acceso total: no hay permisos que marcar.
                </Aviso>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {GRUPOS_PERMISOS.map((g) => {
                    const disponibles = g.permisos.filter((p) => !p.soloSuper || esSuperAdmin)
                    if (!disponibles.length) return null
                    const todos = disponibles.every((p) => editando.permisos.includes(p.clave))
                    return (
                      <div key={g.clave} className="rounded-xl border border-slate-800 bg-slate-900/40 p-2">
                        <label className="mb-1 flex cursor-pointer items-center gap-2 border-b border-slate-800 px-2 pb-1.5">
                          <input
                            type="checkbox"
                            checked={todos}
                            onChange={(e) => alternarGrupo(g, e.target.checked)}
                            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                          />
                          <span className="text-[13px] font-medium text-slate-200">{g.nombre}</span>
                        </label>
                        {disponibles.map((p) => (
                          <Casilla
                            key={p.clave}
                            marcado={editando.permisos.includes(p.clave)}
                            onCambiar={(v) => alternarPermiso(p.clave, v)}
                            nota={p.nota}
                          >
                            {p.nombre}
                          </Casilla>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button onClick={guardar} cargando={guardando} disabled={guardando}>
                {esNuevo ? 'Crear usuario' : 'Guardar cambios'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Cambiar la contraseña */}
      {/* --- Generar la llave de API con los permisos de esta persona --- */}
      <Modal
        abierto={!!apiDe}
        titulo={`Generar API para ${apiDe?.nombre ?? ''} ${apiDe?.apellido ?? ''}`}
        onCerrar={() => {
          setApiDe(null)
          setApiGenerada(null)
        }}
        ancho="max-w-2xl"
      >
        {apiGenerada ? (
          <div className="space-y-4">
            <Aviso tipo="alerta">
              Esta es la única vez que se ve. No se guarda en ningún lado: si se pierde, hay que
              revocarla y generar otra.
            </Aviso>

            <div className="rounded-lg border border-slate-700 bg-slate-950 p-3">
              <code className="block break-all font-mono text-[12px] text-emerald-300">
                {apiGenerada.llave}
              </code>
            </div>

            <Button
              icon={Plug}
              onClick={() => navigator.clipboard.writeText(apiGenerada.llave)}
            >
              Copiar
            </Button>

            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[12px] text-slate-400">
              <p className="text-slate-300">
                Permisos copiados de {apiGenerada.copiada_de}:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {apiGenerada.permisos.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="mt-2 leading-snug">
                Son una <b>foto</b> de los permisos que tiene hoy. Si mañana cambian los suyos,
                esta llave no cambia — y si se desactiva su usuario, la llave sigue funcionando.
                Se edita o se revoca en Ajustes → Integraciones.
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setApiDe(null)
                  setApiGenerada(null)
                }}
              >
                Ya la copié
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault()
              setError(null)
              try {
                const datos = new FormData(e.currentTarget)
                setApiGenerada(
                  await api.integraciones.crearDesdeUsuario({
                    usuario_id: apiDe.id,
                    nombre: datos.get('nombre') || null,
                    ips_permitidas: String(datos.get('ips') ?? '')
                      .split(/[\s,]+/)
                      .filter(Boolean),
                  }),
                )
              } catch (err) {
                setError(err)
              }
            }}
          >
            <Aviso>
              Se van a copiar los permisos que <b>{apiDe?.nombre}</b> tiene hoy, y solo los que
              tiene sentido usar desde afuera: consultar abonados y facturas, registrar pagos,
              diagnosticar, cambiar WiFi, abrir tickets y vender. Nunca eliminar ni anular.
            </Aviso>

            <Field label="Nombre de la llave" hint="Para reconocerla dentro de seis meses.">
              <Input name="nombre" placeholder={`API de ${apiDe?.nombre ?? ''}`} />
            </Field>

            <Field
              label="IPs desde las que puede llamar"
              hint="Separadas por coma. Vacío = desde cualquier lado."
            >
              <Input name="ips" placeholder="200.10.20.30" />
            </Field>

            <Aviso tipo="alerta">
              Nace <b>sin</b> poder acreditar pagos sola: lo que registre queda a verificar. Eso se
              habilita aparte, en Ajustes → Integraciones, junto con la cuenta a la que entra la
              plata.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setApiDe(null)}>
                Cancelar
              </Button>
              <Button type="submit">Generar</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        abierto={!!claveDe}
        titulo={`Nueva contraseña para ${claveDe?.nombre ?? ''}`}
        onCerrar={() => setClaveDe(null)}
      >
        <ClaveForm
          onCancelar={() => setClaveDe(null)}
          onGuardar={async (clave) => {
            try {
              await personalApi.cambiarClave(claveDe.id, clave)
              setClaveDe(null)
              await recargar()
            } catch (err) {
              setError(err)
            }
          }}
        />
      </Modal>

      {/* El historial de una persona */}
      <Modal
        abierto={!!historialDe}
        titulo={`Actividad de ${historialDe?.nombre ?? ''} ${historialDe?.apellido ?? ''}`}
        onCerrar={() => setHistorialDe(null)}
        ancho="max-w-2xl"
      >
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {historial.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              Sin actividad registrada todavía.
            </p>
          ) : (
            historial.map((a) => (
              <div key={a.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
                <div className="text-[13px] text-slate-200">{a.descripcion}</div>
                <div className="mt-0.5 flex gap-3 text-[11px] text-slate-500">
                  <span>{fecha(a.creado_en)}</span>
                  <span className="font-mono">{a.ip || 'sin IP'}</span>
                  <span>{a.accion}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  )
}

/**
 * El formulario de contraseña, aparte.
 *
 * Vive en su propio componente para que lo escrito muera al cerrar el modal:
 * una contraseña que queda en el estado de la pantalla se reabre con el
 * siguiente usuario y se le asigna a quien no era.
 */
function ClaveForm({ onGuardar, onCancelar }) {
  const [clave, setClave] = useState('')
  const [repetida, setRepetida] = useState('')
  const [guardando, setGuardando] = useState(false)

  const corta = clave.length > 0 && clave.length < 8
  const distinta = repetida.length > 0 && clave !== repetida

  return (
    <div className="space-y-3">
      <Field label="Nueva contraseña" hint="Mínimo 8 caracteres.">
        <Input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoFocus />
      </Field>
      <Field label="Repetir">
        <Input type="password" value={repetida} onChange={(e) => setRepetida(e.target.value)} />
      </Field>
      {corta && <Aviso tipo="alerta">La contraseña necesita al menos 8 caracteres.</Aviso>}
      {distinta && <Aviso tipo="alerta">Las dos contraseñas no coinciden.</Aviso>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variante="fantasma" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button
          disabled={clave.length < 8 || clave !== repetida || guardando}
          cargando={guardando}
          onClick={async () => {
            setGuardando(true)
            await onGuardar(clave)
            setGuardando(false)
          }}
        >
          Cambiar contraseña
        </Button>
      </div>
    </div>
  )
}
