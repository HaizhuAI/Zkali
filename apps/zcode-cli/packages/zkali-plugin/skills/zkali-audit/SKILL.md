---
name: zkali-audit
description: 代码审计方法论——入口枚举、source→sink 数据流、分语言危险模式库、依赖与密钥面、报告规范。
---

# 代码审计作战手册

## 三轮打法

1. **结构轮**：技术栈/框架/目录组织 → 画信任边界（哪些输入不可信：HTTP、文件、消息队列、IPC、环境变量）。
2. **数据流轮**：入口枚举 → source→sink 逐条跟踪。污点跨层才算路径（参数→session→拼 SQL→执行）。
3. **模式轮**：分语言危险模式 grep 扫面，回数据流验证。

## 分语言危险信号

- **Java/Kotlin**：`ObjectInputStream.readObject`、fastjson `parseObject`、SnakeYAML `load`、SpEL `getValue`、OGNL、`Runtime.exec` 拼接、`Statement` 拼接、XXE（`DocumentBuilder` 无 disable）、路径穿越 `new File(user)`、Filter/Interceptor 顺序绕过、Shiro rememberMe 反序列化。
- **PHP**：`unserialize`（找 `__destruct`/`__wakeup`/`__toString` 链）、`eval`/`assert`/`create_function`、`include/require $_GET`、`extract`/`$$`、`preg_replace .*/e`、`==` 松散比较（0e hash/数组绕过）、`file_get_contents` SSRF、move_uploaded_file 无白名单。
- **JS/TS**：`eval`/`Function`/`vm.runIn*`、`child_process.exec` 拼接、`lodash merge`/原型链污染、模板（ejs/pug `<%= -%>` 未转义）、JWT `verify` 缺算法约束、危险正则、`res.sendFile` 路径拼接、npm 脚本注入。
- **Python**：`pickle.loads`/`yaml.load`（非 SafeLoader）、`eval`/`exec`、jinja2 `|safe`/render_template_string、subprocess `shell=True`、`os.path.join` 穿越、`assert` 做鉴权（-O 失效）、`flask.session` 弱 secret。
- **Go**：`exec.Command` 拼接、`text/template`（非 html）、`http.Get(userURL)` 无 redirect/协议限制、`filepath.Join` 穿越、`unsafe` 包、goroutine+共享变量竞态。
- **C/C++**：`strcpy`/`strcat`/`sprintf`/`gets`/`scanf %s`、`memcpy` 用户控制长度、malloc(size*count) 整数溢出、free 后使用、`system`/`popen` 拼接、`open`+`access` TOCTOU。

## 依赖与密钥面

- `package-lock`/`go.sum`/`requirements.txt`/`pom.xml` → 版本 → CVE/GHSA 比对；传递依赖别漏。
- 硬编码：`AKIA[0-9A-Z]{16}`（AWS）、`sk-`/`ghp_`/私钥头 `-----BEGIN`、内网 IP、`.env` 提交史（`git log -p` 挖历史密钥）。
- 注释泄露：TODO/BUG/调试代码里残留的测试账号、后门参数（`?debug=`）。

## 报告规范

每条：**文件:行号** + source→sink 数据流 + 触发条件 + PoC（构造请求/输入）+ 严重度（Critical/High/Med/Low）+ 修复一行。可疑未确认单列"待验证"，给验证命令。宁少勿滥。
