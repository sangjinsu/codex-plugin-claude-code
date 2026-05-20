# Codex Plugin Claude Code

Codex에서 로컬 Claude Code CLI를 호출해 구현 계획을 받는 MVP 플러그인입니다.

이 플러그인은 `codex-plugin-cc`의 반대 방향을 목표로 합니다.

- `codex-plugin-cc`: Claude Code에서 Codex 호출
- 이 플러그인: Codex에서 Claude Code 호출

MVP에서는 `claude:setup`, `claude:plan`만 제공합니다. Claude는 계획을 세우고, Codex는 그 계획을 검증한 뒤 구현합니다.

## 설치

이 저장소 자체가 Codex plugin root입니다. 로컬 플러그인으로 사용할 때는 이 디렉터리를 Codex plugin source로 등록합니다.

필수 조건:

- Node.js 20 이상
- 로컬 `claude` CLI
- Claude Code 인증 상태

Claude CLI는 자동 설치하지 않습니다. 설치와 인증은 사용자가 직접 수행합니다.

```bash
claude auth status
```

## claude:setup

Claude CLI와 플러그인 파일 구조를 확인합니다.

```text
claude:setup
```

내부적으로 다음 스크립트를 실행합니다.

```bash
node plugins/claude/scripts/claude-companion.mjs setup
```

확인 항목:

- `claude` CLI 설치 여부
- `claude --version` 실행 가능 여부
- `claude auth status` 인증 상태
- 현재 디렉터리가 프로젝트인지 여부
- MVP에 필요한 plugin 파일 존재 여부

## claude:plan

Claude에게 Codex `/plan`처럼 읽기 전용 구현 계획을 요청합니다.

```text
claude:plan add README usage examples
```

내부적으로 다음 스크립트를 실행합니다.

```bash
node plugins/claude/scripts/claude-companion.mjs plan "add README usage examples"
```

`claude:plan`은 기본적으로 `PLAN.md`를 생성하지 않고 stdout으로만 계획을 반환합니다. Claude CLI 호출은 `Read`, `Glob`, `Grep`, `LS` 도구만 허용해 읽기 전용 계획 수립에 맞춥니다.

## 제한 사항

- Anthropic API를 직접 호출하지 않습니다.
- MCP를 사용하지 않습니다.
- background job을 만들지 않습니다.
- review, status, result, cancel 기능은 아직 없습니다.
- Claude가 반환한 계획은 참고용입니다. Codex가 저장소 상태와 비교해 검증한 뒤 구현해야 합니다.

## 보안

스크립트는 `.env` 값을 읽거나 출력하지 않습니다. 또한 Claude 출력에 명백한 API key, token, private key 패턴이 포함되면 `[REDACTED]`로 마스킹합니다.

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
