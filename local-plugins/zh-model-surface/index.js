/**
 * 将 DSH Web 预设发送给模型的系统提示词和工具说明本地化为简体中文。
 * 工具名、参数名、枚举值与 JSON Schema 结构保持不变。
 */

export const name = 'zh-model-surface'
export const inject = ['systemPrompt']

const SYSTEM_SECTIONS = {
  'harness:identity': '你是一个由 DeepSeek Harness 驱动的 AI 智能体。',
  'deployment:persona': '你是一个由 {{model}} 模型驱动的编程智能体。你的工作目录是 {{cwd}}。除非用户明确要求使用其他语言，否则所有思考和最终回答都使用简体中文。',
  'context:file-reference': '以 @ 开头的路径是用户明确引用的文件。需要查看内容时请使用 read 工具；读取之前，不要声称已经检查过该文件。',
  'tool:read': '使用 read 工具检查文本文件，不要使用 cat 等 shell 命令。结果包含行号；读取大文件时使用 offset 和 limit 继续查看。',
  'tool:write': '使用 write 工具创建文件或完全替换文件内容。该操作会覆盖现有文件，因此应先读取已有文件（默认 fs-observation-policy 要求如此）；局部修改优先使用 edit。',
  'tool:edit': '使用 edit 工具对现有 UTF-8 文本文件进行局部修改。它用 new_string 替换字面匹配的 old_string；默认要求 old_string 恰好出现一次。若出现多次，请提供更具体的 old_string，或将 replace_all 设为 true。除非文件是本次会话刚创建或修改的，否则应先读取文件（默认 fs-observation-policy 要求如此）。',
  'tool:grep': '使用 grep 工具搜索文件内容，不要使用 shell 中的 grep 或 rg。需要查看匹配位置的上下文时，再对匹配文件使用 read。',
  'tool:pwsh': '非零退出状态会显示为 `[exit code: N]`；继续之前应调查失败原因。在 Windows 上，被终止的进程会显示为没有信号标记的 `[exit code: 1]`；中断后仅出现退出码 1 时，应视为进程被终止，而不是命令本身失败。',
  'tool:jobs': '记录你启动的每个后台任务 id。任务结束时会在会话中通知你；不要频繁轮询或休眠等待，应继续处理不依赖该任务的工作，也不要重复执行仍在运行的任务。给出最终回答前，使用 job_output 收集仍然相关的任务（只有确实被其阻塞时才设置 wait: true），并使用 job_kill 停止已经不再需要的任务。',
  'tool:ralph': '只有当直接用户明确要求使用 Ralph 循环或由全新智能体迭代执行时，才使用 ralph 工具。每轮 Ralph 都会启动一个没有对话种子的全新子智能体，并将共享工作区作为持久记忆。完成与阻塞状态来自工作智能体的报告，不代表独立验收。普通的长期目标应使用当前会话的 goal 工具；有明确边界的委派和并行处理应使用普通 subagent 或 workflow。',
  'ui:deliverable-file-references': '成功创建或修改文件后，请在最终回答中说明主要产物。为了让这些文件以及本轮修改的其他文件能在 Web 中点击，请使用 Markdown 行内代码格式写出文件工具使用的准确路径；如果文件名在本轮修改的文件中唯一，也可以只写文件名。',
}

function translateSystemSection(section) {
  const fixed = SYSTEM_SECTIONS[section.name]
  if (fixed !== undefined) return { ...section, text: fixed }

  if (section.name === 'harness:source') {
    const match = /^The DeepSeek Harness implementation checkout is at (.+?)\. The checkout location/s.exec(section.text)
    if (match !== null) {
      return {
        ...section,
        text: `DeepSeek Harness 的实现源码位于 ${match[1]}。源码位置与当前工作目录是两个独立值，二者可能不同；绝不能根据该路径推断工作目录。请使用 pwd 确定当前工作目录。此源码目录只用于检查或扩展 DSH 本身。`,
      }
    }
  }

  if (section.name === 'app:web-surface') {
    const match = /Web GUI at ([^\s.]+(?:\.[^\s.]+)*)\./.exec(section.text)
    const url = match?.[1] ?? 'http://127.0.0.1:3080'
    return {
      ...section,
      text: `你正在通过 ${url} 上的 DeepSeek Harness Web GUI 与用户交互。如果用户提到“这个页面”“这个 GUI”或“这个应用”，且没有指出其他对象，指的就是这个 GUI。浏览器不会隐式提供 DOM、路由或截图上下文。客户端插件的 HMR 接收器已经启用，但只有在同一源码目录中同时运行 \`pnpm run dev:web\` 来重新构建客户端插件包时，客户端插件改动才会无需刷新自动加载；承诺自动更新前必须确认该监听进程正在运行。其他改动（包括 apps/web 外壳和普通 packages）都需要重新构建受影响的 Web 产物，并在刷新页面后通过当前 URL 验证。启动另一个服务器不会更新这个 GUI。apps/web 的 Vite 入口只构建外壳，并不是独立应用，因为只有 dsh web 会注入 window.__DSH_BOOT__。除非用户要求，否则不要启动替代服务器；确实需要时，应使用受管理的后台任务，并验证其准确 URL。`,
    }
  }

  if (section.name === 'tool:glob') {
    const sampled = section.text.includes('sampled across top-level entries')
    const overflow = sampled
      ? '较大的结果会在各顶层条目之间抽样，以覆盖整棵目录树，而不是集中在一个子树中。'
      : '较大的结果只保留按修改时间排序后的前部。'
    return {
      ...section,
      text: `使用 glob 工具按路径模式查找文件，不要使用 shell 的 find。模式中不含“/”时，会在任意深度匹配基本文件名，因此“*”会匹配整棵目录树中的所有文件，而不只是顶层文件。结果只包含文件，绝不包含目录，并且包括隐藏文件和被忽略的文件：结果数量未超限时按修改时间返回；${overflow}`,
    }
  }

  if (section.name === 'tool:web_search') {
    const maxQueries = /accepts 1–(\d+)/.exec(section.text)?.[1] ?? '4'
    const followup = section.text.includes('web_fetch')
      ? '需要查看某条结果的完整内容时继续使用 web_fetch，并用 Markdown 链接引用相关 URL。'
      : '优先使用返回的来源摘要，并用 Markdown 链接引用相关 URL。'
    return {
      ...section,
      text: `使用 web_search 工具查找互联网上的最新信息。必填的 queries 数组接受 1–${maxQueries} 条非空查询；只查询一个主题时传入单元素数组。该工具返回可选的摘要答案和来源 URL 列表。${followup}`,
    }
  }

  if (section.name === 'tool:goal') {
    const rounds = /at least (\d+) consecutive goal rounds/.exec(section.text)?.[1] ?? '3'
    return {
      ...section,
      text: `goal 工具用于当前会话中的一个长期完成目标。create_goal 可以根据任何语言的直接用户请求推断目标意图；普通的单轮任务不要创建 goal。调用 update_goal 前先调用 get_goal，并复制其准确的 goal_id 和 revision。会话恢复或分叉后，活动目标处于未武装状态；当用户以任何语言要求继续或恢复时，使用 update_goal 的 resume 操作重新武装目标。只有目标确实完成时才标记 complete。只有同一个阻塞条件连续至少存在 ${rounds} 个目标轮次时，才标记 blocked，并在 blocked_reason 中说明具体条件；任务困难、不确定或仍有有价值的工作可做，都不算阻塞。`,
    }
  }

  if (section.name === 'tool:workflow') {
    return {
      ...section,
      text: '只有当用户明确要求使用工作流，或要求大规模多智能体编排时，才使用 workflow 工具：编写一个 JavaScript 脚本（准确格式见工具说明），分阶段将工作分发给多个子智能体，并收集结构化结果。只有一两个委派任务时，优先直接调用 subagent。',
    }
  }

  if (section.name.startsWith('tool:subagent')) {
    const toolName = section.name.slice('tool:'.length)
    return {
      ...section,
      text: `默认在后台运行 ${toolName}。在同一条 assistant 消息中一起启动彼此独立的委派，并在它们运行时继续处理其他有价值的工作。只有下一步操作依赖该子智能体的结果时，才设置 \`run_in_background: false\`。后台任务结束后，运行时会发送通知，其中包含执行结果以及可能存在的最终 assistant 消息。`,
    }
  }

  return section
}

function translateRuntimeContext(context) {
  if (context.name === 'sandbox:policy') {
    if (context.text.startsWith('Current DSH file policy: read-only.')) {
      return {
        ...context,
        text: '当前 DSH 文件策略：read-only。受 DSH 文件沙箱约束的操作在常驻模式下不能修改文件。不要仅凭此策略拒绝必要的修改：应正常尝试可用工具，并遵循工具返回的拒绝与权限升级说明。',
      }
    }
    if (context.text.startsWith('Current DSH file policy: workspace-write.')) {
      const workspace = /session workspace: (.+?)\. Some platform/s.exec(context.text)?.[1] ?? '当前会话工作区'
      return {
        ...context,
        text: `当前 DSH 文件策略：workspace-write。受 DSH 文件沙箱约束的可用操作可以修改会话工作区 ${workspace} 下的文件；部分平台临时目录也可能允许写入。`,
      }
    }
    if (context.text.startsWith('Current DSH file policy: danger-full-access.')) {
      return {
        ...context,
        text: '当前 DSH 文件策略：danger-full-access。DSH 文件沙箱不会限制可用操作对文件的修改。',
      }
    }
  }

  if (context.name === 'approval:policy') {
    if (context.text.startsWith('Approval policy: ask.')) {
      return {
        ...context,
        text: '批准策略：ask。需要批准的操作可以通过已配置的回答器询问用户；如果没有可用回答器，请求会以拒绝方式安全失败。',
      }
    }
    if (context.text.startsWith('Approval prompts are disabled in this session:')) {
      return {
        ...context,
        text: '本会话已禁用批准提示：需要批准的操作会被自动拒绝。不要请求沙箱权限升级，也不要设置 `sandbox_permissions`。',
      }
    }
  }

  return context
}

const TOOL_TEXT = {
  ask_user_question: {
    description: '继续操作前，如果需要用户确认、做出选择或补充缺失信息，请提出简明问题。可发送一个或多个问题；每个问题必须包含稳定的 id，该 id 会在答案中原样返回。',
    fields: {
      questions: '继续操作前要向用户提出的问题。',
      'questions[].id': '该问题的稳定 id；会在答案中原样返回。',
      'questions[].question': '要向用户提出的具体问题。',
      'questions[].header': '可选的简短问题标题，例如“确认”或“选择模式”。',
      'questions[].options': '可选的候选项。若要推荐其中一项，请将它放在第一位，并在标签末尾添加“（推荐）”。',
      'questions[].options[].label': '面向用户显示的简短选项标签。',
      'questions[].options[].description': '用一句话说明该选项的权衡或影响。',
      'questions[].multi_select': '是否允许用户选择多个选项。默认为 false。',
    },
  },
  create_goal: {
    description: '当直接用户提出需要跨多个自动目标轮次持续推进的长期目标时，创建一个在当前会话中持久保存的完成目标。可以推断这种意图，无需用户明确说“创建目标”。不要用于简单的单轮任务。非人类权限和子智能体权限调用会被拒绝。',
    fields: {
      objective: '根据直接用户请求推断出的具体完成目标。',
      max_goal_rounds: '可选的自动继续轮次上限，必须是正的安全整数。',
    },
  },
  edit: {
    description: '通过替换字面文本，对现有 UTF-8 文本文件进行编辑。',
    fields: {
      file_path: '要编辑的路径，由文件系统后端解析。',
      old_string: '要替换的字面文本，必须精确匹配。',
      new_string: '用于替换的字面文本；传入空字符串可删除匹配内容。',
      replace_all: '是否替换全部匹配。默认为 false；为 false 时，old_string 必须恰好出现一次。',
      sandbox_permissions: '该文件操作需要的更宽沙箱模式。只能在操作刚被沙箱拒绝后原样重试一次时使用，并且需要提供理由和获得用户批准。',
      justification: '与 sandbox_permissions 一起使用时必填：用一句话向用户说明这次确切的文件操作为何需要更宽权限。',
    },
  },
  exit_plan_mode: {
    description: '仅在计划模式中使用。提交完整计划供用户审阅；用户批准后退出计划模式。plan 必须是完整的 Markdown，并以命名该计划的一级标题开头。用户可以批准（从下一步开始执行）或要求继续规划；根据工具结果中的反馈修订后再次提交。',
    fields: { plan: '完整的 Markdown 计划，必须以命名该计划的一级标题开头。' },
  },
  get_goal: {
    description: '读取当前会话目标，包括准确的 id/revision、目标内容、阶段、已完成的继续轮次、轮次上限、存在时的阻塞原因，以及是否已武装下一次继续。更新目标前必须先调用此工具。',
    fields: {},
  },
  glob: {
    description: '查找路径符合 glob 模式的文件。只返回文件路径，绝不返回目录；包含隐藏文件和被忽略的文件（排除版本控制元数据目录）。最多按修改时间顺序内联返回 100 条；结果更多时返回前 100 条，说明已截断，并报告保存完整排序列表的位置。本工具不用于枚举目录条目。',
    fields: {
      pattern: '用于匹配文件路径的 glob 模式，例如“**/*.ts”或“src/**/*.test.js”。模式中不含“/”时，会在任意深度匹配基本文件名，因此“*”和“*.ts”都会搜索整棵目录树；若要限定深度，请包含路径分隔符。',
      path: '要搜索的目录。默认为会话工作区；相对路径基于该工作区解析。',
    },
  },
  grep: {
    description: '使用 ripgrep 正则表达式搜索文件内容。按文件分组返回带行号的匹配行。最多内联返回前 250 条；达到上限时会报告保存完整匹配列表的位置。需要上下文时，对匹配文件使用 read。',
    fields: {
      pattern: '用于搜索的正则表达式（ripgrep 语法）。',
      path: '要搜索的文件或目录。默认为会话工作区；相对路径基于该工作区解析。',
      include: '一个用于筛选搜索文件的 glob，例如“*.ts”或“*.{js,jsx}”。不是列表，不支持否定模式。',
    },
  },
  interrupt_agent: {
    description: '按 agent id 请求取消后台智能体的当前轮次。目标可以是直接子智能体，也可以是更深层的后代智能体。只有当前轮次会停止：已经排队的消息会保留到以后调用 send_message，目标启动的其他智能体继续运行，目标本身也仍可接收后续任务。取消请求被接受后本工具立即返回，因此目标可能短暂继续运行；取消已经完成的智能体也会作为无操作成功接受。',
    fields: { agent_id: '要中断的运行中智能体 id。' },
  },
  job_kill: {
    description: '按任务 id 请求取消正在运行的后台任务。该工具立即返回；实际工作停止后，任务状态才会变为 killed。',
    fields: {
      job_id: '启动后台工作时返回的任务 id。',
      reason: '可选的简短原因，会记录到日志并转发给任务。',
    },
  },
  job_list: {
    description: '列出你的后台任务（包括运行中和已结束的任务）及其 id、类型和状态。',
    fields: {},
  },
  job_output: {
    description: '读取后台任务。流式任务只返回上次读取后新增的输出；最终结果型任务会在结束后返回其结果。每次响应都以 `[status: ...]` 结尾。读取默认不阻塞；设置 wait: true 后，最多等待到配置的上限。',
    fields: {
      job_id: '启动后台工作时返回的任务 id。',
      wait: '是否阻塞到任务进入终态或等待超时。超时会返回 [status: running]，任务仍继续运行。',
      timeout_ms: '最长等待毫秒数（仅在 wait: true 时有效）。默认为配置的等待时间，并受配置的最大值限制。',
    },
  },
  list_agents: {
    description: '按持久 id 和标签列出可继续的后台子智能体。它用于回忆已启动的子智能体，不要用于轮询完成状态；子智能体结束时会主动通知。状态来自实时注册表：running 表示正在工作；idle 表示已加载但处于轮次之间（可能正在等待它启动的智能体）；ready 表示只存在于持久存储中，可以恢复，但并非终态，也不表示有结果等待收集。对任何状态的直接子智能体调用 send_message，都会在同一对话中启动新一轮。列表快照不保证消息一定可送达；send_message 会执行最终检查，仍可能失败。无法读取的子智能体会以诊断信息报告，不会被静默丢弃。scope 为 descendants 时，会按稳定的前序遍历列出整棵后代树，并注明每项的直接父会话 id 和深度。send_message 只能用于深度 1 的直接子智能体；更深层智能体只能作为 interrupt_agent 的目标。',
    fields: { scope: 'children（默认）只列出直接子智能体；descendants 遍历并列出完整后代树。' },
  },
  pwsh: {
    description: '执行 PowerShell 命令（`pwsh -Command`）并返回 stdout/stderr。每次调用都在新的 pwsh 进程中运行，cwd、变量和函数等状态不会保留；请传入 workdir，不要使用 cd。路径使用 Windows 原生格式（`C:\\...`）；通过 `$env:NAME` 读取环境变量。非零退出显示为 `[exit code: N]`。当前 Harness 环境信息通过受管理的 `$env:DSH_*` 变量提供，需要时可检查。命令可能在文件沙箱中运行；被阻止的文件操作显示为 `[sandbox: file access denied under <mode> mode]`，这表示策略拒绝而不是命令错误，不要换一种方法重试。长输出只保留尾部；如果可用，会报告保存完整输出的文件路径。在 Windows 上，强制终止的命令会显示为没有信号标记的 `[exit code: 1]`，应视为中断而不是命令失败。长时间命令应设置 `run_in_background: true`：调用立即返回任务 id，使用 job_output 读取输出，使用 job_kill 停止。Windows 沙箱的 read-only 模式使用 PowerShell ConstrainedLanguage；workspace-write 通常使用 FullLanguage，除非主机策略另有规定。在 read-only 模式中优先使用 cmdlet 和核心类型；.NET 静态调用、Add-Type、COM 和反射会因“only core types”限制而失败。两种受限模式中的程序都无法打开命名管道，因此通过 Node.js child_process 的默认管道捕获子程序输出会出现 EPERM，而 stdio: inherit、stdio: ignore 和 PowerShell 自身管道不受影响。该 EPERM 是明确限制，不要换方法重试；可以将完全相同的命令升级一次，或改写为不捕获输出。可以直接尝试可能被沙箱拒绝的命令并读取标记。若命令被拒绝且更宽模式能够执行，应在同一轮中使用 sandbox_permissions 和一句 justification 原样重试一次；批准提示本身就是用户授权方式。若会话禁用了批准提示，则拒绝是最终结果，不得设置 sandbox_permissions。不得在没有真实拒绝依据时预先升级。用户拒绝升级后，该命令不得再绕过执行，但仍可尝试其他命令。',
    fields: {
      command: '要执行的 PowerShell 命令。',
      description: '用主动语态写清晰、简短的命令说明，长度 5–10 个词，会显示在 UI 中。例如：“ls”→“列出当前目录文件”，“git status”→“显示工作区状态”，“Get-Process”→“列出运行中的进程”。',
      timeoutMs: '超时时间（毫秒）。执行器会应用配置的默认值和上限，并在超时后终止命令。',
      workdir: '该命令的工作目录。默认为会话工作区；相对路径基于该工作区解析。',
      run_in_background: '是否在后台运行并立即返回任务 id（用 job_output 收集，用 job_kill 停止）。后台任务不设置超时。',
      sandbox_permissions: '该命令需要的更宽沙箱模式。只能在命令刚被沙箱拒绝后原样重试一次时使用，并且需要提供理由和获得用户批准。',
      justification: '与 sandbox_permissions 一起使用时必填：用一句话向用户说明这条确切命令为何需要更宽权限。',
    },
  },
  ralph: {
    description: '围绕一个不可变目标，在前台运行由全新智能体执行的 Ralph 循环。只有直接用户明确要求 Ralph 或全新智能体迭代时才使用。每轮都会启动一个没有父对话和历史子会话的全新子智能体；共享工作区作为长期记忆，轮次之间只传递有界的结构化报告。当工作智能体报告完成或具体阻塞，或达到轮次上限时，调用结束。普通的长期同会话工作应使用 goal 工具。',
    fields: {
      objective: '每个全新 Ralph 轮次共同使用的不可变完成目标。',
      maxRounds: '可选的正安全整数轮次上限，并受部署上限约束。',
    },
  },
  read: {
    description: '读取 UTF-8 文本文件，并返回带行号的内容。',
    fields: {
      file_path: '要读取的路径，由文件系统后端解析。',
      offset: '返回内容的第一行，行号从 1 开始。默认为 1。',
      limit: '最多返回的行数。默认为 2000。',
    },
  },
  read_image: {
    description: '读取 PNG/JPEG/WebP/GIF 文件并返回图像本身。当前模型必须支持图像输入。',
    fields: { file_path: '图像文件路径，由文件系统后端解析。' },
  },
  send_message: {
    description: '按 subagent id 向后台子智能体发送消息，继续同一段对话。该消息会成为子智能体的下一轮：若它仍在工作，消息会等当前轮结束后再送达，因此不能改变正在进行的工作。本调用不会返回子智能体的回答，只确认消息已送达；它适合追加任务。调用失败表示消息没有送达。',
    fields: {
      subagent_id: '启动后台子智能体时返回的 id。',
      message: '要发送给子智能体的消息。',
    },
  },
  skill: {
    description: '加载某个可用 skill 的完整说明。当任务明确点名或明显匹配会话 skill 目录中的某项 skill 时，应先使用目录中的准确名称调用此工具，再开始执行。',
    fields: { name: '可用 skill 列表中的准确名称。' },
  },
  subagent: {
    description: '把一个边界清晰、可独立完成的任务委派给单独上下文中的子智能体，例如研究、局部实现或分析，从而避免占用当前对话上下文。你会收到结果，而不是中间步骤。必须提供完整且独立的提示，因为子智能体看不到当前对话。该工具默认后台运行，立即返回持久 subagent id，并保留子对话供后续轮次使用。执行结束后，运行时会通知父智能体结果及可能存在的最终消息；send_message 可在同一子对话中开启后续轮次。只有下一步依赖该结果时才设置 run_in_background: false。',
    fields: {
      description: '用于显示的简短委派任务说明，长度 3–5 个词。',
      prompt: '给子智能体的完整、独立任务。它不共享当前对话上下文，因此必须包含所需全部信息。',
      run_in_background: '是否在后台运行并立即返回持久 subagent id。默认为 true；只有下一步依赖结果时才设为 false 并等待。',
    },
  },
  subagent_fork: {
    description: '把任务委派给继承当前对话的子智能体：子智能体会获得此前所有已完成轮次，但看不到当前尚未结束的轮次。适合基于当前对话继续分析、审查或推进，同时避免占用当前对话上下文。你会收到结果，而不是中间步骤。该工具默认后台运行，立即返回持久 subagent id，并保留子对话供后续轮次使用。执行结束后，运行时会通知父智能体结果及可能存在的最终消息；send_message 可在同一子对话中开启后续轮次。只有下一步依赖该结果时才设置 run_in_background: false。',
    fields: {
      description: '用于显示的简短委派任务说明，长度 3–5 个词。',
      prompt: '给子智能体的任务。它已看到当前对话中已完成的轮次，可以直接承接上下文，只需说明新增要求。',
      run_in_background: '是否在后台运行并立即返回持久 subagent id。默认为 true；只有下一步依赖结果时才设为 false 并等待。',
    },
  },
  todo_write: {
    description: '记录并更新当前工作的结构化任务列表。每次调用都要发送完整列表，它会替换上一份列表；不支持局部更新或逐项编辑。多步骤工作开始前，每个具体步骤添加一项 todo 并展示进度。正在处理的任务标记为 `in_progress`；真正并行时可有多项，否则顺序工作只设一项。只要还有工作，至少应有一项 `in_progress`。任务完成后立即标记 `completed`，不要批量延迟更新；只有全部完成后才允许没有 `in_progress` 项。简单的单步骤任务无需使用列表。状态值：`pending`（未开始）、`in_progress`（正在处理）、`completed`（已完成）。',
    fields: {
      todos: '完整任务列表，会替换上一份列表。',
      'todos[].content': '任务内容，用简短的祈使句描述。',
      'todos[].status': 'pending（未开始）| in_progress（正在处理）| completed（已完成）。',
    },
  },
  update_goal: {
    description: '更新当前目标的准确 revision。edit、pause 和 resume 必须来自顶层直接用户请求。在当前目标的自动继续轮次中，也允许 complete 和 blocked。未达到配置的最少轮次数时，blocked 会被拒绝；模型仍负责判断同一条件是否持续了这些轮次，并必须在 blocked_reason 中说明。',
    fields: {
      goal_id: 'get_goal 返回的准确 id。',
      revision: 'get_goal 返回的准确正整数 revision。',
      action: 'edit（编辑）| pause（暂停）| resume（恢复）| complete（完成）| blocked（阻塞）',
      objective: '替换后的目标；仅当 action 为 edit 时有效。',
      max_goal_rounds: '替换后的轮次上限；仅当 action 为 edit 时有效。',
      blocked_reason: '具体阻塞条件；仅当 action 为 blocked 时必填。',
    },
  },
  web_search: {
    description: '在互联网上搜索最新信息。必填的 queries 数组提供 1–4 条查询。返回可选的摘要答案和来源 URL 列表。',
    fields: { queries: '必填的搜索查询；接受 1–4 项，并合并它们的结果。' },
  },
  workflow: {
    description: `运行一个用于大规模编排子智能体的 JavaScript 工作流脚本。适用于把工作分散到许多独立部分的场景，例如跨文件审计、迁移、多角度研究或对抗性验证；由脚本完成编排，而不是逐轮手动委派。

工作流身份通过 meta 参数以 JSON 传入：必填 name（短 kebab-case 名称）和 description 字符串；可选 whenToUse 字符串和 phases 数组（{title, detail?, provider?, model?}）。script 参数只能是纯 JavaScript 函数体，不是 TypeScript，也不能包含 export const meta；meta 是参数而不是代码。脚本支持顶层 await，最后必须使用 return <value>，返回值必须可 JSON 序列化，并作为工具结果。

脚本体可用钩子：
- agent(prompt, opts?): Promise<any>：运行一个子智能体直到结束。不设置 opts.schema 时返回子智能体最终文本；设置 opts.schema 时，schema 必须是对象根 JSON Schema，且只能使用 type/properties/required/additionalProperties/items/enum/const/oneOf，返回经过验证的对象。子智能体失败时返回 null，可用 .filter(Boolean) 过滤。其他选项包括 label（显示名称）、phase（进度组）以及相互独立的 provider/model 模型目标覆盖；可以只提供其中一个。其他选项（effort/isolation/agentType）会被明确拒绝。
- pipeline(items, ...stages): Promise<any[]>：让每一项独立通过各阶段，阶段之间没有全局屏障；多阶段工作优先使用它。每个阶段接收 (prev, item, index)。普通阶段抛错会把该项变为 null，并跳过该项剩余阶段。
- parallel(thunks): Promise<any[]>：并发运行零参数函数并等待全部结束，形成屏障；只有某阶段确实依赖所有先前结果时才使用。抛错的函数返回 null。
- phase(title)：开始一个进度阶段；log(message)：报告进度；args：工具调用原样传入的 args 输入。

错误使用钩子（参数错误、未知选项、不支持的 schema 或超过上限）会抛出并终止整个脚本，绝不会退化为某一项的 null。

限制：并发数和智能体总数受上限约束；环境不提供文件系统、网络、计时器或 Node.js API，实际工作由智能体完成，脚本只负责编排。工作流在前台执行，整个脚本结束后工具调用才返回。`,
    fields: {
      script: '纯 JavaScript 工作流脚本体（允许顶层 await；不能包含 `export const meta`；最后使用 `return <json-value>`）。',
      meta: '工作流身份信息块（纯 JSON，不能是代码）。',
      'meta.name': '简短的 kebab-case 工作流名称。',
      'meta.description': '用一行说明工作流的作用。',
      'meta.whenToUse': '可选：说明该工作流适用的情况。',
      'meta.phases': '可选：与 phase() 调用对应的阶段声明。',
      'meta.phases[].title': '阶段标题，必须与 phase() 调用中的字符串精确匹配。',
      'meta.phases[].detail': '可选：用一行说明该阶段。',
      'meta.phases[].provider': '可选：该阶段预期使用的 provider 覆盖。',
      'meta.phases[].model': '可选：该阶段预期使用的 model 覆盖。',
      args: '可选的 JSON 输入，会作为全局变量 args 暴露给脚本。若输入是裸列表，请包装在字段中，例如 {"files": [...]}。',
    },
  },
  write: {
    description: '创建 UTF-8 文本文件，或完全替换其内容。',
    fields: {
      file_path: '要写入的路径，由文件系统后端解析。',
      content: '要写入的完整 UTF-8 文本内容。',
      sandbox_permissions: '该文件操作需要的更宽沙箱模式。只能在操作刚被沙箱拒绝后原样重试一次时使用，并且需要提供理由和获得用户批准。',
      justification: '与 sandbox_permissions 一起使用时必填：用一句话向用户说明这次确切的文件操作为何需要更宽权限。',
    },
  },
}

function translateFields(schema, fields, prefix = '') {
  if (schema === null || typeof schema !== 'object') return schema
  const copy = Array.isArray(schema) ? [...schema] : { ...schema }
  if (copy.properties !== undefined) {
    copy.properties = { ...copy.properties }
    for (const [name, property] of Object.entries(copy.properties)) {
      const path = prefix.length === 0 ? name : `${prefix}.${name}`
      const translated = { ...property }
      if (fields[path] !== undefined) translated.description = fields[path]
      if (translated.properties !== undefined) {
        Object.assign(translated, translateFields(translated, fields, path))
      }
      if (translated.items !== undefined) {
        translated.items = translateFields(translated.items, fields, `${path}[]`)
      }
      copy.properties[name] = translated
    }
  }
  if (copy.items !== undefined) copy.items = translateFields(copy.items, fields, `${prefix}[]`)
  return copy
}

function translateTool(tool) {
  const translation = TOOL_TEXT[tool.name]
  if (translation === undefined) return tool
  return {
    ...tool,
    description: translation.description,
    parameters: translateFields(tool.parameters, translation.fields),
  }
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      sections: assembly.sections.map(translateSystemSection),
      contexts: assembly.contexts.map(translateRuntimeContext),
      tools: assembly.tools.map(translateTool),
    }
  })
}
