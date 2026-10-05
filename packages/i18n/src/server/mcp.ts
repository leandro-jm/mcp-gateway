import { defineMessages } from '../messages';

/** MCP surface: meta-tools, artifact tools, server instructions, protocol errors. */
export const mcp = defineMessages('mcp', {
  en: {
    // effect sentence appended to generated tool descriptions (from the annotations)
    'mcp.effectReadOnly': 'Read-only.',
    'mcp.effectWrites': 'Modifies data.',
    'mcp.effectDestructive': 'Modifies data (destructive operation).',
    // Omni meta-tools
    'mcp.searchToolsTitle': 'Search tools',
    'mcp.searchToolsDescription':
      'Searches, in natural language, the tools available to you on this gateway (hundreds of APIs). ' +
      'Use it before calling any operation. Returns the name, title and short description of the most relevant ones.',
    'mcp.searchToolsQueryDescription': 'What you want to do (e.g. "list an employee\'s vacations")',
    'mcp.getToolSchemaTitle': 'Tool schema',
    'mcp.getToolSchemaDescription': 'Returns the full input schema and the annotations of a tool found with search_tools.',
    'mcp.getToolSchemaNameDescription': 'Exact tool name',
    'mcp.callToolTitle': 'Call a tool',
    'mcp.callToolDescription':
      'Runs a tool by name with the arguments of its input schema (see get_tool_schema). ' +
      'It goes through the same authorization, PII and projection rules as direct calls.',
    'mcp.callToolArgumentsDescription': 'Arguments according to the tool input schema',
    'mcp.omniInstructions': 'This server exposes many tools on demand. Flow: search_tools → get_tool_schema → call_tool.',
    'mcp.omniInstructionsDynamic': 'The tools you find also show up in your tool list.',
    'mcp.omniUnknownTool': 'Unknown tool: {tool}. Use search_tools.',
    'mcp.omniToolNotFound': 'tool {tool} not found (use search_tools)',
    'mcp.useSearchTools': '{error}. Use search_tools.',
    'mcp.argRequired': '{arg} is required',
    'mcp.searchNoResults': 'No tool found for this search. Try other words.',
    // artifact tools and resources
    'mcp.artifactReadTitle': 'Read artifact',
    'mcp.artifactReadDescription':
      'Reads an artifact (artifact://…) returned by another tool, in pages. Lists are paged by records (offset/limit). ' +
      'Prefer artifact_query to filter or aggregate without fetching everything.',
    'mcp.artifactQueryTitle': 'Query artifact (JSONata)',
    'mcp.artifactQueryDescription':
      'Evaluates a JSONata expression over the whole artifact, on the gateway, and returns only the result. ' +
      'Examples: count by field `items{escala_id: $count($)}`; filter `items[ativo=false].nome`; sum `$sum(items.valor)`.',
    'mcp.artifactQueryExpressionDescription': 'JSONata expression',
    'mcp.artifactResourceDescription':
      '{tool}{hasRows, select, true { · {rows, plural, one {# record} other {# records}}} other {}} · expires at {expiresAt}',
    'mcp.artifactTemplateName': 'Artifact',
    'mcp.artifactTemplateDescription': 'Large result of a tool',
    // transport / authentication
    'mcp.missingBearer': 'missing Authorization Bearer header',
    'mcp.userWithoutTenant': 'the token user does not belong to a tenant',
    'mcp.tokenOtherTenant': 'the token belongs to another tenant',
    'mcp.tenantNotFound': 'the token tenant does not exist',
    'mcp.tenantInactive': 'tenant {tenant} is {status}',
    'mcp.sessionNotFound': 'MCP session does not exist or has expired',
    'mcp.sessionOtherSubject': 'the session belongs to another subject',
    'mcp.sessionIdRequired': 'mcp-session-id is required for GET/DELETE',
    'mcp.methodNotAllowed': 'Method not allowed: this endpoint runs in stateless mode (use POST).',
    // observability MCP (F15.14)
    'mcp.obsInstructions':
      'Observability of this gateway for the tenant: usage, errors, latency, gateway overhead and tokens saved. ' +
      'Start with top_failing_tools, drill into a call with explain_call and ask anything else with analytics_query.',
    'mcp.obsAnalyticsQueryTitle': 'Query analytics',
    'mcp.obsAnalyticsQueryDescription':
      'Typed query over call metrics (no SQL): pick a metric, up to 2 groupBy dimensions, filters and a time range. ' +
      'Example: {"metric":"error_rate","groupBy":["tool"],"range":{"last":"7d"}}.',
    'mcp.obsExplainCallTitle': 'Explain a call',
    'mcp.obsExplainCallDescription':
      'Explains one call by id: latency per stage, the policy rule that decided it (and whether it still would), ' +
      'redactions per data type, how much projection cut, tokens and composite steps. Never returns payloads.',
    'mcp.obsExplainCallIdDescription': 'Call id (returned in _meta of every tool result and listed by analytics)',
    'mcp.obsTopFailingTitle': 'Top failing tools',
    'mcp.obsTopFailingDescription':
      'Tools with the most errors in the period: error rate, dominant error code and stage, and the trend against the previous period.',
    'mcp.obsForbidden': 'the observability MCP requires the gateway-admin or analytics-reader role',
    'mcp.obsCallNotFound': 'call {callId} not found',
    // report_outcome (F15.22)
    'mcp.reportOutcomeTitle': 'Report task outcome',
    'mcp.reportOutcomeDescription':
      'Tell the gateway whether the task you were doing with these tools worked. Call it once at the end of a task. ' +
      'It links the outcome to the calls of this session (or to call_ids from _meta) and never stores free text.',
    'mcp.reportOutcomeOutcomeDescription': 'success, partial, failure or abandoned',
    'mcp.reportOutcomeReasonDescription': 'Optional reason code',
    'mcp.reportOutcomeCallIdsDescription': 'Optional call ids (from _meta["io.github.leandro-jm.mcp-gateway/call-id"]) the outcome refers to',
  },
  'pt-BR': {
    'mcp.effectReadOnly': 'Somente leitura.',
    'mcp.effectWrites': 'Altera dados.',
    'mcp.effectDestructive': 'Altera dados (operação destrutiva).',
    'mcp.searchToolsTitle': 'Buscar tools',
    'mcp.searchToolsDescription':
      'Busca, em linguagem natural, as tools disponíveis para você neste gateway (centenas de APIs). ' +
      'Use antes de chamar qualquer operação. Retorna nome, título e descrição curta das mais relevantes.',
    'mcp.searchToolsQueryDescription': 'O que você quer fazer (ex.: "listar férias de um colaborador")',
    'mcp.getToolSchemaTitle': 'Schema de uma tool',
    'mcp.getToolSchemaDescription': 'Retorna o input schema completo e as annotations de uma tool encontrada com search_tools.',
    'mcp.getToolSchemaNameDescription': 'Nome exato da tool',
    'mcp.callToolTitle': 'Chamar uma tool',
    'mcp.callToolDescription':
      'Executa uma tool pelo nome com os argumentos do seu input schema (veja get_tool_schema). ' +
      'Passa pelas mesmas regras de autorização, PII e projeção das chamadas diretas.',
    'mcp.callToolArgumentsDescription': 'Argumentos conforme o input schema da tool',
    'mcp.omniInstructions': 'Este servidor expõe muitas tools sob demanda. Fluxo: search_tools → get_tool_schema → call_tool.',
    'mcp.omniInstructionsDynamic': 'As tools encontradas também passam a aparecer na sua lista de tools.',
    'mcp.omniUnknownTool': 'Tool desconhecida: {tool}. Use search_tools.',
    'mcp.omniToolNotFound': 'tool {tool} não encontrada (use search_tools)',
    'mcp.useSearchTools': '{error}. Use search_tools.',
    'mcp.argRequired': '{arg} é obrigatório',
    'mcp.searchNoResults': 'Nenhuma tool encontrada para esta busca. Tente outras palavras.',
    'mcp.artifactReadTitle': 'Ler artefato',
    'mcp.artifactReadDescription':
      'Lê um artefato (artifact://…) devolvido por outra tool, em páginas. Para listas, pagina por registros (offset/limit). ' +
      'Prefira artifact_query para filtrar ou agregar sem trazer tudo.',
    'mcp.artifactQueryTitle': 'Consultar artefato (JSONata)',
    'mcp.artifactQueryDescription':
      'Avalia uma expressão JSONata sobre o artefato inteiro, no gateway, e devolve só o resultado. ' +
      'Exemplos: contagem por campo `items{escala_id: $count($)}`; filtro `items[ativo=false].nome`; soma `$sum(items.valor)`.',
    'mcp.artifactQueryExpressionDescription': 'Expressão JSONata',
    'mcp.artifactResourceDescription':
      '{tool}{hasRows, select, true { · {rows, plural, one {# registro} other {# registros}}} other {}} · expira em {expiresAt}',
    'mcp.artifactTemplateName': 'Artefato',
    'mcp.artifactTemplateDescription': 'Resultado grande de uma tool',
    'mcp.missingBearer': 'header Authorization Bearer ausente',
    'mcp.userWithoutTenant': 'usuário do token não pertence a um tenant',
    'mcp.tokenOtherTenant': 'token pertence a outro tenant',
    'mcp.tenantNotFound': 'tenant do token não existe',
    'mcp.tenantInactive': 'tenant {tenant} está {status}',
    'mcp.sessionNotFound': 'sessão MCP inexistente ou expirada',
    'mcp.sessionOtherSubject': 'sessão pertence a outro sujeito',
    'mcp.sessionIdRequired': 'mcp-session-id obrigatório para GET/DELETE',
    'mcp.methodNotAllowed': 'Método não permitido: este endpoint opera em modo stateless (use POST).',
    'mcp.obsInstructions':
      'Observabilidade deste gateway para o tenant: uso, erros, latência, overhead do gateway e tokens economizados. ' +
      'Comece por top_failing_tools, aprofunde numa chamada com explain_call e pergunte o resto com analytics_query.',
    'mcp.obsAnalyticsQueryTitle': 'Consultar analytics',
    'mcp.obsAnalyticsQueryDescription':
      'Consulta tipada sobre as métricas de chamadas (sem SQL): escolha uma métrica, até 2 dimensões em groupBy, filtros e um período. ' +
      'Exemplo: {"metric":"error_rate","groupBy":["tool"],"range":{"last":"7d"}}.',
    'mcp.obsExplainCallTitle': 'Explicar uma chamada',
    'mcp.obsExplainCallDescription':
      'Explica uma chamada pelo id: latência por etapa, a regra de política que decidiu (e se ainda decidiria), ' +
      'redactions por tipo de dado, quanto a projeção cortou, tokens e steps de compostas. Nunca devolve payload.',
    'mcp.obsExplainCallIdDescription': 'Id da chamada (vem no _meta de todo resultado de tool e aparece no analytics)',
    'mcp.obsTopFailingTitle': 'Tools que mais falham',
    'mcp.obsTopFailingDescription':
      'Tools com mais erros no período: taxa de erro, código e etapa de erro dominantes e a tendência em relação ao período anterior.',
    'mcp.obsForbidden': 'o MCP de observabilidade exige o papel gateway-admin ou analytics-reader',
    'mcp.obsCallNotFound': 'chamada {callId} não encontrada',
    'mcp.reportOutcomeTitle': 'Informar resultado da tarefa',
    'mcp.reportOutcomeDescription':
      'Diga ao gateway se a tarefa que você fez com estas tools deu certo. Chame uma vez, ao fim de cada tarefa. ' +
      'O resultado é ligado às chamadas desta sessão (ou aos call_ids do _meta) e nunca guarda texto livre.',
    'mcp.reportOutcomeOutcomeDescription': 'success, partial, failure ou abandoned',
    'mcp.reportOutcomeReasonDescription': 'Código de motivo opcional',
    'mcp.reportOutcomeCallIdsDescription': 'Ids de chamadas opcionais (de _meta["io.github.leandro-jm.mcp-gateway/call-id"]) a que o resultado se refere',
  },
  es: {
    'mcp.effectReadOnly': 'Solo lectura.',
    'mcp.effectWrites': 'Modifica datos.',
    'mcp.effectDestructive': 'Modifica datos (operación destructiva).',
    'mcp.searchToolsTitle': 'Buscar tools',
    'mcp.searchToolsDescription':
      'Busca, en lenguaje natural, las tools disponibles para usted en este gateway (cientos de APIs). ' +
      'Úsela antes de llamar cualquier operación. Devuelve el nombre, el título y una descripción corta de las más relevantes.',
    'mcp.searchToolsQueryDescription': 'Lo que quiere hacer (p. ej.: "listar las vacaciones de un empleado")',
    'mcp.getToolSchemaTitle': 'Schema de una tool',
    'mcp.getToolSchemaDescription': 'Devuelve el input schema completo y las annotations de una tool encontrada con search_tools.',
    'mcp.getToolSchemaNameDescription': 'Nombre exacto de la tool',
    'mcp.callToolTitle': 'Llamar una tool',
    'mcp.callToolDescription':
      'Ejecuta una tool por nombre con los argumentos de su input schema (vea get_tool_schema). ' +
      'Pasa por las mismas reglas de autorización, PII y proyección que las llamadas directas.',
    'mcp.callToolArgumentsDescription': 'Argumentos según el input schema de la tool',
    'mcp.omniInstructions': 'Este servidor expone muchas tools bajo demanda. Flujo: search_tools → get_tool_schema → call_tool.',
    'mcp.omniInstructionsDynamic': 'Las tools encontradas también aparecen en su lista de tools.',
    'mcp.omniUnknownTool': 'Tool desconocida: {tool}. Use search_tools.',
    'mcp.omniToolNotFound': 'tool {tool} no encontrada (use search_tools)',
    'mcp.useSearchTools': '{error}. Use search_tools.',
    'mcp.argRequired': '{arg} es obligatorio',
    'mcp.searchNoResults': 'No se encontró ninguna tool para esta búsqueda. Intente con otras palabras.',
    'mcp.artifactReadTitle': 'Leer artefacto',
    'mcp.artifactReadDescription':
      'Lee un artefacto (artifact://…) devuelto por otra tool, en páginas. Las listas se paginan por registros (offset/limit). ' +
      'Prefiera artifact_query para filtrar o agregar sin traer todo.',
    'mcp.artifactQueryTitle': 'Consultar artefacto (JSONata)',
    'mcp.artifactQueryDescription':
      'Evalúa una expresión JSONata sobre el artefacto completo, en el gateway, y devuelve solo el resultado. ' +
      'Ejemplos: conteo por campo `items{escala_id: $count($)}`; filtro `items[ativo=false].nome`; suma `$sum(items.valor)`.',
    'mcp.artifactQueryExpressionDescription': 'Expresión JSONata',
    'mcp.artifactResourceDescription':
      '{tool}{hasRows, select, true { · {rows, plural, one {# registro} other {# registros}}} other {}} · expira el {expiresAt}',
    'mcp.artifactTemplateName': 'Artefacto',
    'mcp.artifactTemplateDescription': 'Resultado grande de una tool',
    'mcp.missingBearer': 'falta el header Authorization Bearer',
    'mcp.userWithoutTenant': 'el usuario del token no pertenece a un tenant',
    'mcp.tokenOtherTenant': 'el token pertenece a otro tenant',
    'mcp.tenantNotFound': 'el tenant del token no existe',
    'mcp.tenantInactive': 'el tenant {tenant} está {status}',
    'mcp.sessionNotFound': 'la sesión MCP no existe o expiró',
    'mcp.sessionOtherSubject': 'la sesión pertenece a otro sujeto',
    'mcp.sessionIdRequired': 'mcp-session-id es obligatorio para GET/DELETE',
    'mcp.methodNotAllowed': 'Método no permitido: este endpoint opera en modo stateless (use POST).',
    'mcp.obsInstructions':
      'Observabilidad de este gateway para el tenant: uso, errores, latencia, overhead del gateway y tokens ahorrados. ' +
      'Empieza por top_failing_tools, profundiza en una llamada con explain_call y pregunta lo demás con analytics_query.',
    'mcp.obsAnalyticsQueryTitle': 'Consultar analytics',
    'mcp.obsAnalyticsQueryDescription':
      'Consulta tipada sobre las métricas de llamadas (sin SQL): elige una métrica, hasta 2 dimensiones en groupBy, filtros y un período. ' +
      'Ejemplo: {"metric":"error_rate","groupBy":["tool"],"range":{"last":"7d"}}.',
    'mcp.obsExplainCallTitle': 'Explicar una llamada',
    'mcp.obsExplainCallDescription':
      'Explica una llamada por id: latencia por etapa, la regla de política que la decidió (y si todavía lo haría), ' +
      'redacciones por tipo de dato, cuánto recortó la proyección, tokens y pasos de compuestas. Nunca devuelve payloads.',
    'mcp.obsExplainCallIdDescription': 'Id de la llamada (viene en _meta de cada resultado de tool y aparece en analytics)',
    'mcp.obsTopFailingTitle': 'Tools que más fallan',
    'mcp.obsTopFailingDescription':
      'Tools con más errores en el período: tasa de error, código y etapa de error dominantes y la tendencia frente al período anterior.',
    'mcp.obsForbidden': 'el MCP de observabilidad requiere el rol gateway-admin o analytics-reader',
    'mcp.obsCallNotFound': 'llamada {callId} no encontrada',
    'mcp.reportOutcomeTitle': 'Informar resultado de la tarea',
    'mcp.reportOutcomeDescription':
      'Dile al gateway si la tarea que hiciste con estas tools funcionó. Llámala una vez, al final de cada tarea. ' +
      'El resultado se vincula a las llamadas de esta sesión (o a los call_ids de _meta) y nunca guarda texto libre.',
    'mcp.reportOutcomeOutcomeDescription': 'success, partial, failure o abandoned',
    'mcp.reportOutcomeReasonDescription': 'Código de motivo opcional',
    'mcp.reportOutcomeCallIdsDescription': 'Ids de llamadas opcionales (de _meta["io.github.leandro-jm.mcp-gateway/call-id"]) a los que se refiere el resultado',
  },
});
