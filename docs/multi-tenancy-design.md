# 多租户架构设计

> 范围:把 RunForge 从"单实例单租户"改造为"单实例多租户"——同一个部署（同一个进程、同一个数据库）
> 服务多个互相隔离的租户,而不是给每个租户单独起一套部署。
> 目标:描述**改造完成后**的目标架构,作为 [系统设计](system-design.md) 中"多租户鉴权、用户隔离、
> 项目隔离和审计权限"这条待办的具体化。
> 状态:Phase 1(§4 认证/用户/JWT 骨架)已实施;§5-§9 的数据层改造(业务表加
> tenant_id/user_id、RLS、workspace 按租户拆分、管理员审计)仍未开始。日期:2026-07-14,
> Phase 1 实施于 2026-07-17。

---

## 1. 设计目标与非目标

目标:

- 一次部署可以承载多个租户,租户之间**数据不可见、文件不可见、执行不可互相影响**。
- 租户内部支持**多用户**,每个用户有独立身份(账号)和登录态,而不是把整个 tenant 当成一个不可再分的责任主体。
- 认证从静态共享 token 升级为 **JWT**,携带用户和租户身份,支持有效期和吊销,而不是"一个 token 打天下"。
- 提供一条**显式、留痕**的管理员审计路径:租户管理员能看自己租户范围内用户的对话,系统管理员能跨租户查看,服务合规审计和平台侧 observability/debug 需求——但这条路径和普通用户的默认使用路径是分开的,不是角色权限的隐式副作用(细节见 §4)。
- 现有单租户部署可以**零改动升级**,全新部署也能**开箱即用**——两者都靠同一套启动期 bootstrap 逻辑,自动确保存在一个 `default` tenant 和至少一个 `owner` 账号(见 §4)。
- 隔离强度可以分层生效:先保证数据库和文件系统的逻辑隔离,再逐步收紧到执行层的强隔离(沙箱/容器)。

非目标(明确不做,或留给更后续的迭代):

- 不做租户自建/自服务的完整 SaaS 控制台(计费、套餐、公开注册审批流程)——新用户由租户内的 owner/admin 创建,不做面向公网的自助注册。
- 不做细粒度的资源级权限矩阵(谁能看哪个具体 thread 的按资源 ACL);本次只做 owner/admin/member 三档角色 + §2 里约定的默认可见性规则。
- 不假设租户之间需要跨租户协作或数据共享;需要共享的数据(如内置 skill/workflow)单独处理,见 §8。
- 不支持一个用户同时属于多个租户(no cross-tenant membership);如果未来需要"一个账号切换多个团队",在 `users` 之上加一张 `tenant_memberships` 关联表即可扩展,现在按"一个用户属于一个租户"简化,匹配当前"tenant = 一个团队部署"的产品形态。
- 不在这版设计里引入独立的任务队列或多 worker 横向扩展——那是 [长任务设计](long-task-design.md) 的范畴,和多租户是正交的两件事,可以分别推进。

---

## 2. 租户模型

一个 **tenant** 对应一个独立的使用方(一个团队、一个客户),拥有:

- 一组 **用户(user)**,每个用户有独立的登录身份,归属这一个 tenant。
- 独立的一组 thread / run / subagent / shell session / datasource 数据。
- 独立的 workspace 文件树。
- 独立的运行时配置(LLM provider、工具沙箱策略、MCP servers)。

`tenant_id` 是贯穿改造的主键,取值为短字符串(如 `tnt_xxx`),不对外暴露内部自增 id。单租户部署使用一个固定的 `default` tenant,行为与今天完全一致(不管是迁移还是全新部署,启动时都会自动确保这个 tenant 和一个默认管理员账号存在,见 §4 的 bootstrap 逻辑)。

### 租户角色 vs 系统管理员

改造涉及两层完全不同的身份,不要混为一谈:

- **租户角色**(`owner`/`admin`/`member`):都属于某一个具体 tenant,管理边界止步于**这一个** tenant 内部——这是下面"用户与角色"讲的内容。
- **系统管理员(system admin)**:不属于任何 tenant,是运营这个 RunForge 部署本身的人(平台方/运维),职责是创建/暂停/删除 tenant、跨租户的 observability 和问题排查,见 §4。

**为什么系统管理员要和租户角色彻底分开,而不是给 `owner` 再加一档"超级 owner"权限:**

- tenant owner/admin 的职责边界应该就是"管好自己这一个团队",不应该天然具备"看到别的团队数据"的能力。如果系统级操作只是"权限更高一档的 tenant 角色",很容易在代码实现上出现"tenant admin 不小心跨了 tenant 边界"的漏洞——因为查询逻辑本来就要判断"这个角色能看多大范围",多一档角色就多一处可能判断错的分支。
- 让 system admin 是完全独立的身份(独立的表、独立的登录入口、独立的 JWT claims 结构,见 §4),是在**架构层面直接切断**"tenant 内角色能不能升级到看别的 tenant"这条路径,而不是靠"权限判断代码写对"来保证——一个不存在的入口,不会因为某处判断写漏了而被打开。
- 现实中,"运营/开发这个平台的人"和"使用这个平台的某个团队负责人"通常是完全不同的人(甚至不同公司),数据库表结构和登录体系上分开,更贴近这个事实,而不是伪装成同一套账号体系里的不同权限档位。

### 用户与角色

租户内部的用户带一个角色字段,决定管理类操作的权限,不做更细粒度的资源 ACL:

| 能力 | `owner` | `admin` | `member` |
|---|---|---|---|
| 使用 agent(创建/操作自己的 thread) | ✓ | ✓ | ✓ |
| 创建/禁用 `member` | ✓ | ✓ | ✗ |
| 创建/禁用/提升 `admin`,或对另一个 `owner` 做任何变更 | ✓ | ✗ | ✗ |
| 管理租户级运行时配置(LLM/沙箱策略/MCP) | ✓ | ✓ | ✗ |
| 颁发/吊销 API token | ✓ | ✗ | ✗ |
| 暂停/删除整个 tenant | ✓ | ✗ | ✗ |
| 通过审计接口查看本租户内其他用户的对话(留痕,见 §4) | ✓ | ✓ | ✗ |

**为什么要分 `owner` 和 `admin` 两级,而不是一个"管理员"角色:**

- **防止租户被锁死**:如果只有一种管理员角色,"最后一个管理员被禁用或误操作降级"会导致整个租户没有人能再管理它。`owner` 是一个不能被 `admin` 触碰(创建/禁用/降级)的身份,任何时候至少保留一个活跃 `owner`(见 §4 的引导逻辑),给租户留一条"总能找到人负责"的退路。
- **收敛最高风险操作的颁发范围**:API token 是长期有效、拿到就能持续以某个用户身份调用的凭证——泄露的影响面和"一次性密码"完全不是一个量级。把"谁能签发/吊销它"限制在人数最少的 `owner`,是在"这类操作需要经常做"和"做错代价很高"之间选择后者优先,而不是图方便让所有管理员都能发。同理,暂停/删除 tenant 这种不可逆或影响全体成员的操作也只留给 `owner`。
- **`admin` 承担的是日常运营,不是租户的最终控制权**:邀请新成员、调整 LLM/沙箱这类"经常需要做、做错影响有限、可以再改回来"的操作,交给 `admin` 处理,不需要每次都找 `owner`,这是引入 `admin` 这一级的价值——如果没有 `admin`,`owner` 就会变成日常运营的瓶颈;但 `admin` 的权限边界止步于"不触碰账号体系本身和最高风险操作",避免"日常运营角色"逐渐膨胀成事实上的第二个 owner。

### 数据可见性

thread(以及挂在 thread 下的 run/message/subagent_run/shell_session)**默认严格属于创建它的用户**。面向普通用户的默认使用路径(前端聊天界面、`/api/threads` 等常规接口)在任何角色下都只按 `tenant_id = ? AND user_id = ?` 过滤,没有隐藏的角色旁路——member 之间、以及 member 与 owner/admin 之间,通过这条默认路径互相看不到对方的对话内容。这与"AI 助手是个人工具"的产品直觉一致(类似同一个 Slack workspace 里,机器人 DM 不互相可见),而不是团队共享收件箱模型。

**管理员审计是这条默认规则之外唯一的例外**,用于合规/support/观测排障,权限范围和实现见 §4"管理员审计"——但它是一条独立、显式声明、全程留痕的旁路,不是"因为你是 admin 所以顺便能看",两者的区别很关键:default 路径(聊天界面、`/api/threads`)永远不会因为调用者是 owner/admin/system admin 就返回别人的数据;只有专门的审计 API 才会,且每次调用都写审计日志。把这两条路径分开、而不是在同一个接口里加一个 `if role === 'admin'` 分支,是为了不让"管理员能看审计"退化成"管理员的所有请求都能看"。

`datasource`(数据源连接)、租户级运行时配置(LLM/沙箱/MCP)是**租户级共享资源**,不挂在具体用户下——它们本质是团队共用的基础设施,任何 member 都能用,但只有 owner/admin 能新增/修改。

---

## 3. 架构总览

在 [系统设计](system-design.md) 的架构图基础上,新增一层"租户/用户上下文":

```text
React Web (携带用户登录态:JWT access token + refresh token)
  |
  | REST / WebSocket
  v
Server (Node.js / TypeScript 单体)
  |
  |-- 认证层:JWT -> {tenant_id, user_id, role},写入 AsyncLocalStorage 请求上下文
  |
  |-- API 层(不变,但所有 handler 从上下文取 tenant_id / user_id / role)
  |
  |-- Agent 执行循环
  |     |-- ContextManager / Provider / Skill·Workflow registry / Tool registry / Subagent runner
  |     `-- Run bus(按 tenant_id 分片订阅)
  |
  |-- Shell manager(按 tenant_id 分片的 active-command 表)
  |
  |-- Store 抽象
  |     |-- PgStore:所有查询强制带 tenant_id(+ user_id,见 §2 可见性规则)过滤 + RLS 兜底
  |     `-- MemoryStore:测试用,按 tenant_id 分 Map
  |
  |-- Workspace 根:tenants/<tenant_id>/workspace
  |-- Sandbox:bwrap bind mount 只挂载该租户的 workspace
  |
  v
PostgreSQL(单库,行级按 tenant_id / user_id 隔离)
```

请求处理主线(新增部分加粗):

```text
Web 带 JWT access token 发起请求
-> **认证中间件验证 JWT 签名和过期时间 -> {tenant_id, user_id, role} -> AsyncLocalStorage.run(ctx, next)**
-> 后续所有 API handler、executeRun、tool registry、store 查询
   都从 AsyncLocalStorage 取 {tenant_id, user_id, role},不需要显式在每层传参
-> Store 层查询自动带上 tenant_id(+ 按 §2 规则的 user_id)条件(应用层 + 数据库 RLS 双保险)
-> 文件工具/沙箱按 tenant_id 派生的 workspaceRoot 执行
-> 事件经 run bus 按 tenant_id 过滤后推送给对应租户的 WebSocket 连接
```

选择 `AsyncLocalStorage` 而不是显式给每个函数加 `tenantId`/`userId` 参数,是因为现有代码库(`executeRun`、`runTool`、`registry.ts` 等)链路很深,显式传参需要改动几乎每一个函数签名;`AsyncLocalStorage` 能在不改动大多数函数签名的前提下,让 store/沙箱/文件路径这些"叶子层"直接读取当前身份,改造面更小。代价是身份上下文变成隐式的,需要在关键出口(定时任务、跨 run 的后台恢复逻辑)显式确认上下文被正确建立,不能假设"当前在一个 async 调用链里就一定有上下文"。

---

## 4. 认证与身份

现有的"静态共享 Bearer Token"整个替换为 **JWT + 用户登录**,而不是简单地把 token 拆成多条记录。两类凭证并存,服务不同场景:

- **用户会话(交互登录)**:邮箱/密码登录后签发一个短期 **access JWT**(默认 30~60 分钟过期)和一个不透明的 **refresh token**(存 hash,较长有效期,如 30 天),前端用 refresh token 静默换取新的 access JWT,不需要用户频繁重新输入密码。
- **服务/API token(自动化调用)**:面向 CI、脚本、集成场景,不走登录流程,由 `owner` 直接颁发一个长期有效的不透明 token(为什么只有 owner 能发,见 §2),同样只存 hash;这类 token 绑定 `tenant_id` + 一个具体 `user_id`(以谁的身份调用、遵循谁的可见性规则),而不是绑定"tenant 本身"这样一个匿名主体。

### JWT 结构

```json
{
  "sub": "usr_xxx",
  "scope": "tenant",
  "tenant_id": "tnt_xxx",
  "role": "member",
  "iat": 1752460800,
  "exp": 1752464400
}
```

- 签名算法用 **HS256**,密钥来自新增的 `RUNFORGE_JWT_SECRET` env——单体部署没有跨服务验签的需求,不需要上非对称密钥的复杂度。
- `requireApiAccess` 中间件验证签名和 `exp`,通过后把 `{tenantId, userId, role}` 写入 `AsyncLocalStorage`;签名或过期校验失败一律 401,前端捕获后用 refresh token 静默重试一次,仍失败则跳转登录页。
- Access token **不查库**(纯签名验证,O(1)、无 DB 往返),这是从"每请求查 token 表"升级到 JWT 的主要收益;代价是 access token 一旦签发,在过期前无法主动吊销——靠短过期时间(30~60 分钟)把"已吊销用户仍能用旧 token"的窗口限制在可接受范围内,真正的即时封禁通过用户 `status = 'disabled'` 在业务层拒绝(见 §5),而不是指望 JWT 层面撤销。
- `scope` 字段区分这是一个租户用户 token 还是系统管理员 token(见下),两者的 claims 结构不同,校验时先看 `scope` 再决定按哪套规则解析,避免系统管理员 token 被误当成租户 token 使用(反之亦然)。

### 系统管理员认证

系统管理员和租户用户是两套完全独立的身份体系(理由见 §2),因此:

```sql
CREATE TABLE system_admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- 独立的登录入口 `POST /api/system/auth/login`(不复用 `/api/auth/login`),避免和租户用户的登录混在一起——两者面向的是完全不同的前端界面(普通用户看到的聊天应用 vs 运维/平台方看到的管理后台)。
- 系统管理员的 JWT 没有 `tenant_id`/`role` 这两个字段,换成 `scope: 'system'`:
  ```json
  { "sub": "sysadm_xxx", "scope": "system", "iat": ..., "exp": ... }
  ```
- `requireApiAccess` 按 `scope` 分流:`scope: 'tenant'` 的 token 只能访问租户范围的接口(`/api/threads`、`/api/tenants/:id/...` 且 `:id` 必须等于 token 里的 `tenant_id`);`scope: 'system'` 的 token 只能访问系统管理接口(`/api/system/...`),两者互不通用——租户 JWT 拿不到任何 `/api/system/*` 的访问权限,系统管理员 JWT 也不能直接冒充某个租户用户去调普通接口(需要走 §"管理员审计"里单独设计的只读旁路,而不是直接获得该用户的完整操作权限)。

### 管理员审计(observability / debug)

这是 §2"数据可见性"里提到的唯一例外路径,服务两类场景:合规/support 需要查看某个用户的对话内容,以及平台侧排查问题(比如用户反馈某次 run 结果不对,需要复现当时的完整上下文)。设计成一条独立、显式、留痕的旁路,而不是把"能看"做成 owner/admin/system admin 角色自带的默认能力:

- **接口分离**:`GET /api/tenants/:id/audit/threads`(`owner`/`admin`,要求 `:id` 等于调用者自己的 `tenant_id`,即只能审计自己租户内的用户)、`GET /api/system/audit/threads?tenantId=`(system admin,`tenantId` 不受限,可以是任意租户)。这两个接口和面向普通用户的 `/api/threads` 是完全不同的 handler,不共享代码路径——防止未来有人往 `/api/threads` 顺手加一个"如果是 admin 就放开条件"的分支,让默认路径悄悄变成"默认可见,只是查询更严格"。
- **强制留痕**:每次调用这两个审计接口,不论谁调用、查的是谁,都写一条 `audit_access_log`(见 §5 表结构),记录 `actor_kind`(`tenant_admin` / `system_admin`)、`actor_id`、被查看的 `tenant_id`/`user_id`/`thread_id`。这张表只能追加,不对 tenant owner/admin 开放删除权限(即使是审计自己租户的 owner,也不能删掉自己查看别人对话的记录)——审计能力本身也要被审计,不能自己审自己还能销毁证据。
- **数据库层隔离**:审计查询走一条独立的 RLS 策略,只有在 handler 显式 `SET app.audit_mode = 'true'` 时才生效(见 §5),普通请求处理路径永远不会设置这个 session 变量,因此永远不会命中审计策略——即使代码某处误用了错误的 SQL,数据库层也不会因为调用者角色是 admin 就意外放行。
- **范围边界**:tenant owner/admin 的审计范围永远限定在自己的 `tenant_id` 内,不能跨租户;system admin 没有 `tenant_id` 限制,但每次查看仍然是"查某一个具体租户的具体用户",不存在"一次性拉取所有租户所有用户对话"的批量接口——避免把 observability 需求做成了一个数据导出后门。

### 表结构(新增/替换)

```sql
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,        -- argon2id
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- refresh token(交互登录续期)和 api token(自动化调用)复用同一张表,靠 kind 区分。
CREATE TABLE auth_tokens (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('refresh', 'api')),
  token_hash    TEXT NOT NULL UNIQUE,  -- 只存 hash,不存明文,风格与既有 workload_tokens 一致
  label         TEXT,                  -- api token 的备注名,refresh token 可为空
  expires_at    TIMESTAMPTZ,           -- refresh token 必填;api token 可为空(长期有效,靠 revoked_at 收回)
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, kind, revoked_at);
```

### 认证 API(新增)

- `POST /api/auth/login` `{email, password}` -> `{accessToken, refreshToken}`。
- `POST /api/auth/refresh` `{refreshToken}` -> `{accessToken}`(校验 hash、`expires_at`、`revoked_at`)。
- `POST /api/auth/logout` `{refreshToken}` -> 置 `revoked_at`。
- `POST /api/tenants/:id/tokens`(仅 `owner`)-> 创建一条 `kind='api'` 的 token,一次性返回明文,之后只能看到 `label` 和创建时间,不可再查看明文——这是长期 token 的标准做法,防止后台被拖库后直接拿到可用凭证。
- `POST /api/tenants/:id/users`(`owner`/`admin`,但只有 `owner` 能把 `role` 设成 `admin`/`owner`;`admin` 调用这个接口只能创建 `member`)-> 创建用户,直接设置初始密码(自托管场景没有邮件发送基础设施,先不做邀请邮件/自助改密的流程,由管理员分发初始密码即可)。

### 请求校验路径

`requireApiAccess` 中间件依次尝试:

1. `Authorization: Bearer <token>` 是 JWT 格式 -> 验证签名和过期时间,通过则写入身份上下文。
2. 不是 JWT 格式(不含两个 `.` 分隔的三段结构)-> 按 `auth_tokens.kind = 'api'` 查 hash 表(需要查库,但只有自动化调用走这条路径,QPS 远低于交互流量)。
3. 两条路径都失败 -> 401。

### 默认租户与默认管理员引导(bootstrap)

不管是**从现有单租户部署迁移**,还是**全新部署第一次启动**,系统都不能出现"没有任何 tenant、没有任何能登录的账号"这种状态——否则新装的系统连第一个用户都创建不了。做法是在服务启动时跑一段幂等的引导逻辑(风格与 `server/src/db/migrate.ts` 现有的启动期迁移一致,而不是要求运维手动执行一次性脚本):

```text
启动时:
1. 确保 tenants 表有一行 id = 'default'(不存在则插入,已存在则跳过)
2. 确保 default tenant 下至少有一个 status='active' 的 owner 用户
   -> 已存在:什么都不做(幂等,不会在每次重启时重置密码或重复建号)
   -> 不存在,分两种情况:
      a. 迁移场景:配置了 RUNFORGE_ACCESS_TOKEN
         -> 创建 users 记录(email='admin@local', tenant_id='default', role='owner')
         -> 把 RUNFORGE_ACCESS_TOKEN 的值注册成一条 auth_tokens(kind='api') 记录,绑定这个用户
         -> 现有依赖静态 token 的脚本/集成不需要改动就能继续工作,同时有了一个可登录、
            可以再创建其他用户和颁发/吊销 token 的入口账号
      b. 全新部署:没有配置 RUNFORGE_ACCESS_TOKEN(没有旧数据,也没有旧凭证可复用)
         -> 同样创建 admin@local / role=owner
         -> 密码默认是固定值(`1234.RunForge.5678`),运维可通过 RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD
            指定成别的值(生产/公网环境强烈建议指定,不要用默认密码),数据库只存 hash
         -> 运维用这个密码登录后,应尽快改密或直接创建真实的具名 owner 账号
```

两种情况收敛到同一段逻辑、同一张表结构,不需要维护两套初始化代码路径——区别只在于"密码从哪来":迁移场景复用旧 token 的语义(继续能用),全新部署走固定默认密码。选固定默认值而不是随机生成并打印一次,是因为自托管场景下运维更在意"装完就有一个记得住的账号能登录",而不是每次重装都要翻启动日志找一次性密码——这个取舍以牺牲"默认密码本身不是秘密"为代价,所以生产/公网环境必须通过 RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD 覆盖,不能依赖默认值。

同一段引导逻辑再加一步,确保至少有一个可用的系统管理员:

```text
3. 确保 system_admins 表至少有一个 status='active' 的账号
   -> 已存在:跳过
   -> 不存在:创建 email='sysadmin@local' 的账号,密码规则和 2.b 完全一致
      (固定默认值,或读 RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD)
```

单租户部署下,这个系统管理员账号大部分时候用不上(不需要创建第二个 tenant,也不太需要跨租户排障),但它始终存在,保证"以后要扩成真正的多租户"时不需要再补一次引导逻辑,也不需要区分"老部署没有 system admin、新部署才有"这种不一致状态。

### 其他改动

- 文件分享签名(`signFileShare`/`verifyFileShare`)保持现有 HMAC 机制不变(它服务的是"免登录的临时分享链接"这个场景,和用户身份无关),但签名内容里加入 `tenant_id`,防止一个租户签发的分享链接被拼接/重放到另一个租户的路径上。
- WebSocket 认证:`runforge-token.<base64>` 子协议里传的从静态 token 换成 access JWT,验证方式与 REST 一致;access JWT 过期时前端在建连前用 refresh token 换新的即可,不需要 WebSocket 协议本身支持"连接中途换 token"。

---

## 5. 数据模型

改造原则:**加列,不拆库**。所有业务表加 `tenant_id`,应用层查询强制带过滤条件,数据库层用 Row Level Security(RLS)兜底,双保险防止漏写 `WHERE` 导致跨租户读取。

以现有 `server/src/db/schema.sql` 为基准,改造方式(风格与现有的幂等 `ALTER TABLE ADD COLUMN IF NOT EXISTS` 迁移一致):

```sql
ALTER TABLE threads              ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id);
ALTER TABLE threads              ADD COLUMN IF NOT EXISTS user_id   TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE subagent_runs        ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id);
ALTER TABLE shell_sessions       ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id);
ALTER TABLE datasources          ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id);
ALTER TABLE push_subscriptions   ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id);
```

`threads.user_id` 落地 §2 的可见性规则:记录创建者,任何查询(包括 owner/admin 发起的)都按 `tenant_id = ? AND user_id = ?` 过滤,没有放开 `user_id` 条件的例外路径。允许为空(`ON DELETE SET NULL`)是因为通过服务 API token 发起的调用绑定的是某个具体用户,但如果这个用户后续被删除,历史 thread 不应该级联删除,只需要断开归属显示为"已删除用户"(此时该 thread 对所有人都不再可查——`user_id IS NULL` 不会匹配任何 `user_id = ?` 条件,数据仍在但等同不可达,如需清理由运维直接按 `tenant_id` 批量导出/删除)。

`subagent_runs`、`shell_sessions` 不需要单独的 `user_id`——它们总是挂在某个 `thread`(或 `parent_run_id` 间接指向的 thread)之下,归属通过 `thread_id`/`parent_run_id` 传递,不需要冗余存一份。`datasources` 是 §2 定义的租户级共享资源,故意不挂 `user_id`。

`runs`、`steps`、`messages`、`events`、`shell_commands`、`shell_command_logs`、`datasource_accounts` 等表不直接加 `tenant_id`/`user_id`——它们已经通过外键(`thread_id`/`run_id`/`session_id`/`datasource_id`)间接归属某个租户和用户,直接加列会造成冗余且要保证和父表一致。这些表的隔离通过 `JOIN` 父表或 RLS 策略引用父表间接实现:

```sql
CREATE POLICY tenant_isolation_runs ON runs
  USING (thread_id IN (
    SELECT id FROM threads
    WHERE tenant_id = current_setting('app.tenant_id')
      AND user_id = current_setting('app.user_id')
  ));
```

这条默认策略不给 `owner`/`admin`/system admin 留旁路条件——普通请求路径下,对话内容对任何角色都一视同仁地私有。管理员审计(§4)是唯一的例外,靠**另一条**只在审计 handler 里才生效的permissive 策略实现(Postgres RLS 里同一张表可以有多条 permissive 策略,命中任意一条即放行),而不是修改上面这条默认策略:

```sql
CREATE POLICY tenant_audit_runs ON runs
  USING (
    current_setting('app.audit_mode', true) = 'true'
    AND thread_id IN (
      SELECT id FROM threads
      WHERE current_setting('app.system_admin', true) = 'true'
         OR (
           current_setting('app.role', true) IN ('owner', 'admin')
           AND tenant_id = current_setting('app.tenant_id', true)
         )
    )
  );
```

`app.audit_mode` 只在处理 `/api/tenants/:id/audit/*`、`/api/system/audit/*` 这两类请求时才会被 `SET`,普通请求(包括 owner/admin 发起的普通请求)的数据库连接上这个变量永远是空,因此这条策略永远不生效——审计能力完全隔离在专门的代码路径里,不会因为"调用者角色够高"而在别处意外触发。

审计留痕表:

```sql
CREATE TABLE audit_access_log (
  id                BIGSERIAL PRIMARY KEY,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('tenant_admin', 'system_admin')),
  actor_id          TEXT NOT NULL,    -- users.id(tenant_admin)或 system_admins.id(system_admin)
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_thread_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_access_log_target ON audit_access_log(tenant_id, target_user_id, created_at);
```

这张表只允许 `INSERT`,应用层不暴露任何 `DELETE`/`UPDATE` 路径——包括对 `tenant_admin` 自己产生的记录,防止"审计者销毁自己审计行为的证据"。

`app_settings` 是当前的全局 key-value 配置表(LLM provider、工具沙箱策略、MCP servers),多租户下必须变成按租户可覆盖:

```sql
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id);
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);
```

`getToolSettings`/`getMcpSettings`/`getLlmSettings` 读取时按 `(tenant_id, key)` 查询;若某租户没有覆盖某个 key,回退到 `('default', key)` 的全局默认值,再回退到 `config.ts` 里的 env 默认值——形成"env 默认值 -> 全局 default 租户覆盖 -> 具体租户覆盖"三层,与现在"env 默认值 -> app_settings 覆盖"的两层模型是自然扩展,不是推倒重来。

Store 层(`server/src/store/pgStore.ts`)所有查询方法签名加 `{tenantId, userId}` 参数(`role` 只用于 API 层的操作权限判断,不参与数据查询过滤,见 §2),SQL 里对应加 `AND tenant_id = $n AND user_id = $m`,或者对间接表加等价的 `thread_id IN (...)` 子查询。RLS 作为兜底防线,不作为唯一防线——应用层显式过滤仍然要做,因为 RLS 依赖每个数据库连接正确 `SET app.tenant_id / app.user_id`,一旦连接池复用时忘记重置就会失效,不能单独依赖它。

---

## 6. 文件系统与 workspace 隔离

`workspaceRoot` 从 `config.tools.workspaceRoot` 这个全局单值,变成按租户派生:

```text
${TOOL_WORKSPACE_ROOT_BASE}/tenants/<tenant_id>/workspace
```

- `getToolSettings()` 返回值里的 `workspaceRoot` 字段改为函数调用 `resolveWorkspaceRoot(tenantId)`,而不是读一个全局常量。
- `normalizeRemotePath`/`isWithin`(`server/src/files/workspace.ts`)的围栏逻辑不需要改——它们已经是"给定一个 root,判断路径是否在 root 内",只要传入的 root 换成租户专属路径即可。
- Office 预览缓存(`server/src/files/officePreview.ts`)的 `officeCacheDir` 同理按租户分目录:`${officeCacheDir}/tenants/<tenant_id>/`,避免不同租户上传同路径同名文件时缓存 key 冲突或产生侧信道。
- 单租户部署:`tenant_id = 'default'` 时,`resolveWorkspaceRoot('default')` 直接返回原来的 `TOOL_WORKSPACE_ROOT`(不额外套 `tenants/default/` 前缀),保证现有部署的文件路径不因升级而漂移。

---

## 7. Agent 执行与沙箱隔离

延续 [工具沙箱设计](tool-sandbox.md) 已确立的两层模型(应用层路径策略 + bwrap OS 隔离),多租户在这两层之上都要收紧:

**应用层路径策略**:围栏 root 从全局 `workspaceRoot` 换成按租户派生的 root(见 §6),不需要新增机制,直接复用现有的 `none`/`workspace`/`allowlist` 三档策略。

**bwrap 沙箱层**:`--bind <workspaceRoot> <workspaceRoot>` 的 `workspaceRoot` 同样换成租户专属路径,天然做到"租户 A 的 shell 子进程即使命令被绕过,也 bind mount 不到租户 B 的文件"。命令白名单(`shellAllowCommands`)、网络开关(`network`)从全局 `config.tools.*` 改为按租户读取(存在 `app_settings` 里,见 §5),允许不同租户有不同的工具权限策略——例如某些租户禁用网络访问,某些租户允许更大的命令白名单。

**全局单例改造**:现有代码里几个 module-level 的全局状态,都要从"单例"变成"按 tenant_id 分片":

| 单例 | 现状 | 改造方式 |
|---|---|---|
| `runBus`(`server/src/agent/bus.ts`) | 一个进程级 `EventEmitter`,按 `runId` 发布 | 事件 payload 里带 `tenant_id`;WebSocket 订阅时按 `tenant_id` 过滤,防止拿到别的租户 run 的事件(即使 runId 猜不到,也不依赖"猜不到"作为唯一防线) |
| `shellManager`(`server/src/shell/manager.ts`) | 单例,`active: Map<string, ActiveCommand>` 覆盖所有租户所有 run | 保持单例(它管理的是同进程内的子进程句柄,天然是进程级资源),但每条 `ActiveCommand` record 带 `tenant_id`,查询/清理逻辑按 tenant 过滤;`shell_sessions.workspace_root` 已经是租户专属路径,间接保证了同一 session 不会跨租户复用 |
| `officePreview.ts` 的 `inflight` Map | key = `{path, size, mtime, converterUrl}` 的 hash,全局去重 | key 里加入 `tenant_id`,因为 §6 之后 path 已经是租户专属路径,天然不会跨租户碰撞,这里只是显式保证 |

**执行强隔离(容器化)是下一阶段,不在本次范围内**:上述改造把"数据/文件隔离"做到位,但 shell 工具仍然是"同进程 spawn 子进程 + bwrap namespace",不是"每个租户/每个 run 一个独立容器"。如果未来需要防御"租户能自定义/上传恶意二进制并诱导 bwrap 白名单外执行"这类更强的威胁模型,才需要升级到每 run 一个容器/microVM(gVisor、Firecracker),并配 CPU/内存/进程数配额。这是 [工具沙箱设计](tool-sandbox.md) §5"何时该做强隔离"里已经讨论过的优先级判断——多租户本身不强制要求这一步,只是让"是否需要"这个信号从"要不要对外" 变成了明确的"是"。

---

## 8. Skills / Workflows

- 内置 skill/workflow(`server/src/skills/builtin/`、`server/src/workflows/builtin/`)继续全局共享——它们是代码自带的能力,不含租户数据,没有隔离必要,所有租户看到同一份。
- 用户自定义 skill(`<workspaceRoot>/.skills/<name>`)因为 §6 已经把 `workspaceRoot` 换成了租户专属路径,`loadSkillIndex(workspaceRoot)` 不需要额外改造就自动按租户隔离——传入不同租户的 root,天然读到不同的 `.skills/` 目录。
- 唯一要注意的是 `activateSkill` 物化内置 skill 到 `<workspaceRoot>/.agents/skills/<name>` 的逻辑(`registry.ts:168-177`)——这个物化操作现在会在每个租户的 workspace 下各跑一份,属于预期行为(每个租户独立物化,互不影响),不需要额外去重。

---

## 9. 配置模型:全局 vs 租户级

改造后配置分两层:

- **实例级配置**(`config.ts`,继续来自 env,进程启动时冻结):监听端口、数据库连接串、`RUNFORGE_ACCESS_TOKEN`/`RUNFORGE_SHARE_SECRET` 的兜底值、OTEL 开关、Web Push VAPID key——这些描述的是"这个部署长什么样",不因租户而变,继续保持全局单值。
- **租户级配置**(`app_settings` 表,`(tenant_id, key)` 为主键,见 §5):LLM provider/model/key、工具沙箱策略(`sandbox`/`workspaceRoot` 派生规则/`shellAllowCommands`/`network`)、MCP servers——这些描述的是"这个租户希望 agent 怎么表现",允许每个租户不同。

`preview.officeConverterUrl`(office 预览转换服务地址)保持实例级——它是一个外部服务的地址,不需要每个租户配一份,但 `officeCacheDir` 的实际写入路径按 §6 分租户子目录。

---

## 10. 前端

- 新增登录页:邮箱 + 密码提交到 `POST /api/auth/login`,拿到 `{accessToken, refreshToken}`。相比现在"直接在设置里填一个 token"的模型,这是本次改造里前端唯一必须新增交互的部分。
- `web/src/api.ts` 里的 `authHeaders` 从"读一个固定 token"变成"读内存里的 access token";access token 只存内存(page 生命周期内的变量),`refreshToken` 存 `localStorage`(与现状"token 存本地"的存储方式保持一致,权衡见下)。
- 请求拦截逻辑:每次请求前检查 access token 是否临近过期(或收到 401 后),先用 `refreshToken` 调 `POST /api/auth/refresh` 静默换新 token 再重试一次;`refreshToken` 本身也失效(过期/被吊销)则清空本地状态,跳转登录页。
- WebSocket 连接时用当前 access token 作为 `runforge-token.<base64>` 子协议值;access token 中途过期不会主动断连,但重连时(网络抖动、页面恢复)需要用最新 access token 重建连接。
- `RemoteFilesPanel.tsx` 等文件类组件操作的 `path` 字符串保持"相对当前 workspace 根"的语义不变——隔离发生在后端把 `path` 解析成实际磁盘路径这一步(§6),前端不需要知道自己在哪个租户下,也不需要感知 `tenant_id`/`user_id` 字段本身,这些完全由 JWT 隐式携带。
- 安全权衡:access token 存内存 + 短过期时间,是为了在"前端有 XSS 风险时,被偷到的 token 影响面尽量小"和"不引入 httpOnly cookie + CSRF 防护这一整套额外机制"之间选一个够用的折中;`refreshToken` 仍是长期有效凭证,若要进一步收紧,可以把它也换成 httpOnly cookie(需要后端配合处理 CORS/CSRF),这一步作为后续加固项,不在本次范围内展开。

---

## 11. 安全边界与残留风险

改造完成后(即 §5-§9 都实施完)的隔离强度:

- ⏳ 数据库层:应用层查询过滤 + RLS 双保险,跨租户读写数据库需要绕过两层防御。**Phase 1 现状**:`threads`/`runs` 等业务表还没加 `tenant_id`/`user_id` 列,这一条尚未实现。
- ⏳ 文件系统层:不同租户 workspace 是磁盘上完全不同的目录树,应用层路径围栏 + bwrap bind mount 双保险。**Phase 1 现状**:`workspaceRoot` 还是全局单值,尚未按租户派生。
- ⏳ 事件流:WebSocket 按 tenant_id 过滤 run bus 事件,不依赖 runId 不可猜测。**Phase 1 现状**:`runBus`/`shellBus` 还是纯 `runId`/`threadId` 键控,没有 `tenant_id` 过滤——`ws.ts` 目前只做到了"系统管理员 JWT 连不上这些频道"(scope 校验),**没有**做到"租户 A 连不上租户 B 的 run/thread 事件"。后者需要业务表先有 `tenant_id` 才能实现,是 §5 完成后才补的能力,当前是已知、未缓解的残留风险,不要误以为这一条已经完成。
- ✅ 用户可见性:default 查询按 `(tenant_id, user_id)` 双重过滤 + RLS 兜底,同租户内的普通用户看不到彼此的 thread;唯一的例外(管理员审计)是独立代码路径 + 独立 RLS 策略 + 强制留痕,不是默认路径的隐式行为。
- ⚠️ 管理员审计本身是一个需要被信任的高权限能力:tenant owner/admin 能看到本租户任意成员的对话,system admin 能看到任意租户任意成员的对话——这不是"漏洞",而是设计如此(见 §1/§4),但意味着这两类身份的账号安全(密码强度、是否启用后续可能加的 2FA)比普通 member 更值得重视,一旦这两类账号被盗,影响面是"审计范围内的所有对话",需要在运营上对这两类账号的登录/密码策略从紧要求,这一版设计不包含强制 2FA,留作后续加固项。
- ⚠️ JWT 吊销延迟:access JWT 一旦签发,在过期前无法撤销(§4),用户被禁用/踢出后仍可能有一个短窗口(access token 的过期时长)内继续使用旧 token;通过把过期时间设短(30~60 分钟)把风险窗口控制在可接受范围,而不是引入一张"已吊销 access token 黑名单"表把 JWT 又变回每请求查库。
- ⚠️ refresh token / API token 是长期有效的不透明凭证,一旦泄露且未及时吊销,可以一直用到 `expires_at`/手动吊销为止——依赖 §4 的"只存 hash、创建时一次性显示明文"降低泄露概率,吊销响应速度取决于运营是否及时。
- ⚠️ 执行层:shell 工具仍是同进程 + namespace 隔离,不是容器级强隔离;理论上如果 bwrap 配置有疏漏(如白名单命令本身有越权能力,例如白名单里的 `psql` 如果连接串配置不当),仍可能造成跨租户影响。这是 §7 提到的"下一阶段"要解决的问题,当前设计里作为已知风险记录,而不是假装已经解决。
- ⚠️ 资源配额:CPU/内存/磁盘配额目前仍未实现(与单租户现状一致),多租户下"一个租户跑满资源影响其他租户"(noisy neighbor)问题需要额外的 cgroup/rlimit 工作,不在本次范围。
- ⚠️ 引导账号默认密码是固定值(`1234.RunForge.5678`),不是随运行环境随机生成的秘密——只要读过这份文档或代码就知道默认密码,生产/公网环境**必须**通过 `RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD`/`RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD` 覆盖,或登录后立刻改密,否则默认密码本身就是一个公开的后门。

---

## 12. 参考

- [系统设计](system-design.md) —— 本设计改造的基线架构,"当前边界"一节列出了多租户是待办项。
- [工具沙箱设计](tool-sandbox.md) —— 应用层路径策略 + bwrap 两层模型的选型依据,本设计直接复用并按租户参数化。
- [长任务设计](long-task-design.md) —— run 级 lease/心跳/跨 worker 接管,与多租户正交,可分别推进。
