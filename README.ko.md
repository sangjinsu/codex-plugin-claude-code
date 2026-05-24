[English](README.md) | **한국어**

# Codex Plugin Claude Code

Codex Plugin Claude Code는 Codex에서 로컬 Claude Code CLI에 읽기 전용 구현 계획을 요청하는 최소 Codex 플러그인입니다.

이 플러그인은 `codex-plugin-cc`의 반대 방향을 목표로 합니다.

- `codex-plugin-cc`: Claude Code에서 Codex 호출
- 이 플러그인: Codex에서 Claude Code 호출

기본 흐름은 단순합니다. Claude가 계획을 세우고, Codex가 저장소 상태와 비교해 계획을 검증한 뒤, Codex가 구현합니다.

## 기능

- `claude:doctor`: Claude CLI, 인증, prompt 실행, 프로젝트 상태, 플러그인 파일을 진단합니다.
- `claude:setup`: 로컬 Claude Code CLI와 플러그인 파일 준비 상태를 확인합니다.
- `claude:plan`: Claude에게 읽기 전용 구현 계획을 요청합니다.
- `claude:skills`: 계획에서 참조할 수 있는 로컬 및 글로벌 Claude Code skill을 조회합니다.

## 설치

이 저장소가 Codex plugin root입니다. 로컬 플러그인으로 사용할 때는 이 디렉터리를 Codex plugin source로 등록합니다.

필수 조건:

- Node.js 20 이상
- 로컬 `claude` CLI
- Claude Code 인증 상태

이 플러그인은 Claude를 자동 설치하지 않습니다. Claude Code를 별도로 설치하고 인증한 뒤, 접근 가능 여부를 확인합니다.

```bash
claude auth status
```

## claude:doctor

`claude:setup`보다 자세한 진단을 실행합니다. 읽기 전용 Claude prompt smoke test까지 확인합니다.

```text
claude:doctor
```

`claude:plan`이 인증 오류, 빈 출력, timeout으로 실패할 때 먼저 사용합니다.

## claude:setup

Claude CLI 사용 가능 여부, 인증 상태, 프로젝트 상태, 필수 플러그인 파일을 확인합니다.

```text
claude:setup
```

내부적으로 다음 스크립트를 실행합니다.

```bash
node plugins/claude/scripts/claude-companion.mjs setup
```

확인 항목:

- `claude` CLI 설치 및 실행 가능 여부
- `claude --version` 실행 성공 여부
- `claude auth status` 인증 상태
- 현재 디렉터리가 프로젝트처럼 보이는지 여부
- 필수 plugin 파일 존재 여부

## claude:plan

Claude에게 Codex `/plan`처럼 읽기 전용 구현 계획을 요청합니다.

```text
claude:plan add README usage examples
```

내부적으로 다음 스크립트를 실행합니다.

```bash
node plugins/claude/scripts/claude-companion.mjs plan "add README usage examples"
```

`claude:plan`은 기본적으로 `PLAN.md`를 생성하지 않습니다. 계획은 stdout으로만 반환합니다.

Claude CLI 호출은 `Read`, `Glob`, `Grep`, `LS` 도구만 허용합니다. Claude는 필요한 context를 읽을 수 있지만 파일을 수정할 수 없습니다.

Skill을 함께 사용할 수도 있습니다.

```text
claude:plan --list-skills --query plan
claude:plan --list-skills --query "implementation plan"
claude:plan --recommend-skills frontend polish
claude:plan --dry-run --show-skills add frontend validation
claude:plan --show-skills add frontend validation
claude:plan --skill superpowers:writing-plans add release checklist
claude:plan --skills frontend-design,global-review add UI validation plan
```

`--recommend-skills`와 `--dry-run`은 Claude를 호출하지 않습니다. 실제 계획 실행 전에 skill을 고르거나 Claude에 전달될 context를 확인할 때 사용합니다.

Claude는 다음 섹션을 반환해야 합니다.

- `Summary`
- `Current Understanding`
- `Plan`
- `Validation`
- `Risks`

## claude:skills

로컬과 글로벌 Claude Code skill 목록을 조회합니다.

```text
claude:skills --scope all --query frontend
claude:skills --scope all --query "production-grade frontend"
```

조회 범위:

- `local`: 현재 프로젝트의 `skills/`, `.claude/skills/`, `.claude/plugins/`
- `global`: `~/.claude/skills/`, `~/.claude/plugins/cache/`, `~/.agents/skills/`
- `all`: local과 global skill 모두

`--query`는 skill id, name, description, path를 함께 검색합니다. 따라서 skill 이름을 몰라도 설명에 들어 있는 문구로 찾을 수 있습니다.

text 출력은 읽기 쉽게 긴 description을 줄입니다. 전체 description과 path가 필요하면 `--format json`을 사용합니다.

## 문제 해결

- setup은 통과하지만 `claude:plan`이 실패하면 `claude:doctor`를 실행합니다.
- `401 Invalid authentication credentials`가 보이면 `claude auth login`을 실행한 뒤 `claude:doctor`를 다시 실행합니다.
- `Usage credits required for 1M context`가 보이면 <https://claude.ai/settings/usage>에서 usage credits를 켜거나 Claude CLI가 standard context model을 사용하도록 설정한 뒤 `claude:doctor`를 다시 실행합니다.
- 계획 실행이 timeout되면 더 좁은 요청으로 다시 실행하거나 `claude:plan --dry-run <request>`로 prompt를 먼저 확인합니다.

## 제한 사항

- Anthropic API를 직접 호출하지 않습니다.
- MCP를 사용하지 않습니다.
- background job을 만들지 않습니다.
- review, status, result, cancel workflow는 아직 제공하지 않습니다.
- Claude가 반환한 계획은 참고용입니다. Codex가 저장소 상태와 비교해 검증한 뒤 구현해야 합니다.

## 보안

스크립트는 `.env` 값을 읽거나 출력하지 않습니다. Claude 출력에 명백한 API key, token, private key 패턴이 포함되면 해당 값을 `[REDACTED]`로 마스킹합니다.

절대 출력하면 안 되는 값:

- API key
- token
- cookie
- SSH key
- `.env` 값
- Claude 인증 정보
- Codex 인증 정보

## 개발

```bash
npm run lint
npm test
node plugins/claude/scripts/claude-companion.mjs --help
```
