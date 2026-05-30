# AGENTS.md

## 목표

이 저장소는 Codex에서 Claude Code CLI를 호출하는 플러그인을 만든다.

이 플러그인은 `codex-plugin-cc`의 반대 방향을 목표로 한다.

- `codex-plugin-cc`: Claude Code에서 Codex 호출
- 이 플러그인: Codex에서 Claude Code 호출

처음에는 `claude:setup`과 `claude:plan`만 구현했고, 기본 흐름이 안정화된 뒤 같은 read-only 원칙으로 `claude:doctor`, `claude:review`, `claude:skills`를 더했다.

Claude는 계획하거나 리뷰하고, Codex는 검증한 뒤 구현한다.

## 역할

### Claude Code CLI

Claude는 다음을 담당한다.

- 구현 계획 수립
- 저장소 구조 이해
- 변경 대상 파악
- 구현 순서 제안
- 검증 방법 제안
- 리스크 정리

Claude는 파일을 직접 수정하면 안 된다.

### Codex

Codex는 다음을 담당한다.

- 저장소 분석
- Claude CLI 호출
- Claude 계획 검증
- 실제 파일 수정
- 테스트 실행
- 최종 결과 요약

Claude의 출력은 참고용 계획이다.
Codex는 반드시 저장소 상태와 비교해 검증한 뒤 구현한다.

## 명령어

모든 명령어는 read-only다. Claude는 조사하고 조언하며, 파일은 Codex가 수정한다.

### claude:doctor

`claude:doctor`는 `claude:setup`보다 자세한 진단을 수행한다.

- Claude CLI 설치·실행 여부
- 인증 상태
- read-only prompt smoke test
- 프로젝트 상태와 필수 플러그인 파일

`claude:plan`이 인증 오류, 빈 출력, timeout으로 실패할 때 먼저 사용한다.

### claude:setup

`claude:setup`은 Claude Code CLI 사용 가능 여부를 확인한다.

- `claude` CLI가 설치·실행되는지
- 현재 디렉터리가 유효한 프로젝트인지
- 플러그인에 필요한 파일과 스크립트가 존재하는지

Claude CLI가 없어도 자동 설치하지 않고, 설치가 필요하다는 메시지만 출력한다.

### claude:plan

`claude:plan`은 Claude에게 Codex의 `/plan`처럼 행동하도록 요청한다.

Claude는 관련 파일·구조 파악, 현재 상태 요약, 구현 계획 작성, 검증 방법 제안, 리스크 정리만 수행한다.

Claude는 파일 수정, 코드 구현, 커밋, destructive command 실행, 비밀 정보 출력을 하지 않는다.

기본적으로 `PLAN.md`를 만들지 않고 계획을 stdout으로 반환한다. 사용자가 명시적으로 요청한 경우에만 계획 문서를 저장한다.

### claude:review

`claude:review`는 Claude에게 현재 git diff를 read-only로 검토하도록 요청한다.

기본은 working tree를 `HEAD`와 비교하며, `--staged`는 staged 변경분을, `--base <ref>`는 지정한 ref와의 diff를 검토한다. 변경분이 없으면 Claude를 호출하지 않는다.

plan과 동일한 read-only 제약과 비밀 마스킹이 적용된다.

### claude:skills

`claude:skills`는 plan과 review가 참조할 수 있는 로컬·글로벌 Claude Code skill을 조회한다.

## 기대하는 Plan 출력 형식

Summary

- 무엇을 변경할지 요약한다.

Current Understanding

- 관련 파일
- 현재 동작
- 제약 사항

Plan

1. 첫 번째 구현 단계
2. 두 번째 구현 단계
3. 세 번째 구현 단계

Validation

- Codex가 실행할 검증 명령
- 기대 결과

Risks

- 주의할 점
- 사이드 이펙트
- 확인해야 할 엣지 케이스

## 기대하는 Review 출력 형식

Summary

- diff가 무엇을 바꾸는지 요약한다.

Findings

- correctness / security / style로 분류한다.
- 보고할 내용이 없으면 "None"을 사용한다.

Risks

- 사이드 이펙트, 엣지 케이스, Codex가 확인할 불확실성.

Suggestions

- Codex가 취할 구체적 수정. 가능하면 파일을 지목한다.

Verdict

- `ready` 또는 `needs changes`.

## 저장소 구조

실제 구조는 다음과 같다.

```text
.codex-plugin/plugin.json
plugins/claude/scripts/claude-companion.mjs
plugins/claude/prompts/        # plan.md, review.md
skills/                        # doctor, setup, plan, review, skills
tests/claude-companion.test.mjs
.github/workflows/ci.yml
README.md
README.ko.md
AGENTS.md
```

복잡한 구조는 피한다. Codex가 Claude CLI를 호출하고 Claude가 계획·리뷰를 반환하는 흐름을 단순하게 유지한다.

## 구현 원칙

- Anthropic API를 직접 호출하지 않고, 로컬에 설치된 `claude` CLI를 사용한다.
- 스크립트는 가능하면 Node.js로 작성한다.
- 복잡한 오케스트레이션은 추가하지 않는다.
- MCP와 백그라운드 작업은 도입하지 않는다.
- 동기 실행 방식을 유지한다.

## 보안 규칙

비밀 정보를 노출, 출력, 저장, 커밋하지 않는다.

다음 값은 절대 출력하지 않는다.

- API 키
- 토큰
- 쿠키
- SSH 키
- `.env` 값
- Claude 인증 정보
- Codex 인증 정보

`.env` 파일을 읽을 때는 변수명만 사용하고 값은 사용하지 않는다.

## 테스트

스크립트를 변경하면 최소한 다음을 확인한다.

```bash
node plugins/claude/scripts/claude-companion.mjs --help
npm run lint
npm test
```

테스트가 없다면 최소한 smoke test를 추가한다.

## README 요구사항

README에는 다음 내용을 포함한다.

- 이 플러그인이 무엇인지, `codex-plugin-cc`와 어떻게 반대 방향인지
- 설치 방법
- 각 명령어(`doctor`, `setup`, `plan`, `review`, `skills`) 사용법
- 제한 사항
- 보안 주의사항

## 최종 원칙

작게 시작한다. 기본 흐름은 다음과 같다.

1. 사용자가 Codex에 요청한다.
2. Codex가 Claude CLI를 호출한다.
3. Claude가 `/plan`처럼 계획을 반환하거나 diff를 리뷰한다.
4. Codex가 결과를 검증한다.
5. Codex가 구현한다.

이 흐름이 안정화된 뒤 read-only review를 추가했다. status, result, cancel, MCP, background job은 아직 추가하지 않는다.
