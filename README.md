# DB Studio

DBeaver 를 대체하는 사내용 데이터베이스 조회 · SQL 편집 도구. Electron + React + TypeScript 로 만들었고
MySQL / MariaDB / PostgreSQL 을 지원한다.

## 설치

| OS | 파일 |
| --- | --- |
| macOS (Apple Silicon / Intel) | `DB Studio-*-arm64.dmg` / `DB Studio-*.dmg` |
| Windows | `DB Studio Setup *.exe` |
| Linux | `DB Studio-*.AppImage` 또는 `.deb` |

> 코드 서명을 하지 않았으므로 첫 실행 때 경고가 뜬다.
> macOS 는 앱을 우클릭 → 열기, Windows 는 SmartScreen 에서 `추가 정보` → `실행` 을 누른다.

## 소스로 실행

`git clone` 만으로는 실행되지 않는다. Electron 런타임이 npm 으로 내려받는 바이너리라서
`npm install` 이 반드시 필요하다 (약 480MB, 첫 설치는 수 분 걸린다).

Node 20 이상이 필요하다 (`.nvmrc` 에 20.20.2 지정).

```bash
git clone <저장소 주소>
cd dbstudio
nvm use
npm install
npm start
```

개발 모드 (Vite 개발 서버 + Electron 동시 실행, 저장하면 바로 반영):

```bash
npm run dev
```

### 최신 코드로 갱신하고 실행

새 기능이 올라온 뒤에는 이 한 줄이면 받아오기 · 의존성 설치 · 빌드 · 실행까지 끝난다.

```bash
npm run update
```

`git pull --ff-only` 이므로 로컬에 아직 안 올린 커밋이 있으면 덮어쓰지 않고 멈춘다.
그럴 때는 먼저 정리한 뒤 다시 실행한다.

### Dock 에 고정해 쓰기 (macOS)

`npm run update` 는 소스 실행이라 터미널에 묶인다. 평소에 앱처럼 쓰려면 한 번 설치해 둔다.

```bash
npm run app          # 빌드 + ~/Applications/DB Studio.app 에 설치
```

Finder 에서 `~/Applications/DB Studio.app` 을 열고 Dock 에 고정한다.
다음부터 갱신은 이 한 줄이고, **Dock 고정은 그대로 유지된다.**

```bash
npm run update:app   # 받아오기 + 설치 + 갱신
```

`release/` 안의 앱을 직접 Dock 에 고정하면 안 된다.
electron-builder 는 재빌드마다 그 번들을 통째로 지웠다 새로 만들어서 고정이 끊긴다.
`npm run app` 은 설치본의 번들 디렉터리는 그대로 두고 내용만 덮어쓰기 때문에 고정이 살아남는다.

- 앱이 실행 중이면 덮어쓰지 않고 멈춘다. 완전히 종료한 뒤 다시 실행한다.
- 설치 위치를 바꾸려면 `DBSTUDIO_APP_DIR=/Applications npm run app` 처럼 지정한다.

## 구현된 기능

| 요구사항 | 구현 |
| --- | --- |
| DB 연결 | 접속 정보 저장/편집/삭제, 연결 테스트, 비밀번호는 OS 키체인(`safeStorage`)으로 암호화 저장. 저장하지 않으면 접속 시 입력받는다. 여러 접속을 동시에 열 수 있다. |
| 테이블 조회 및 검색 | 좌측 트리 상단 검색창에서 DB·스키마·테이블 이름을 즉시 필터링. `범위` 를 열면 컬럼명·주석·스크립트(정의)까지 DB 에 직접 질의해 찾는다 |
| 테이블 컬럼 및 데이터 확인 | Properties 탭(컬럼/키/외래키/참조/인덱스/DDL) 과 Data 탭(그리드) |
| SQL 편집기 | CodeMirror 6 기반. DB 종류에 맞는 문법 강조·자동완성, 커서 위치 문장 실행(⌘/Ctrl+Enter), 스크립트 전체 실행(⌘/Ctrl+⇧+Enter), 문장별 결과 탭. 편집기·결과 사이를 끌어 높이를 조절한다 |
| 쿼리 구분 | 세미콜론 기준이 기본이고, `구분` 을 `세미콜론 + 빈 줄` 로 바꾸면 빈 줄도 문장 경계로 본다 |
| 탭 관리 | 탭 우클릭으로 닫기 / 오른쪽 탭 닫기 / 다른 탭 모두 닫기 / 탭 모두 닫기 |
| 커밋 / 롤백 | 자동/수동 커밋 전환, 수동 모드에서 첫 문장 실행 시 트랜잭션 시작. 커밋·롤백 전에 변경 내역을 보여 주고 확인받는다 |
| SQL 편집기 목록 | 열려 있는 편집기를 내용 미리보기와 함께 목록으로 보여 주고, 이동·이름 변경·삭제·모두 닫기 |
| 변경 내역 | 상태 표시줄의 `트랜잭션 진행 중 (n건)` 을 누르면 아직 확정하지 않은 변경 문장이 탭으로 열린다 |
| 스키마 드롭다운 | 상단 툴바의 DB / 스키마 드롭다운. 선택 시 실제로 전환된다 (MySQL `USE`, PostgreSQL `SET search_path`) |
| 위치 정보 노출 | 편집기 상단 브레드크럼 `접속 › DB › 스키마 › 테이블` |
| 테이블 탭 구분 | 열린 객체마다 탭 생성, 탭 선택 시 화면 전환, 가운데 클릭으로 닫기 |
| 좌측 트리그리드 | `접속 › DB › 스키마 › 테이블` (MySQL 은 DB=스키마이므로 스키마 계층 생략), 우클릭 컨텍스트 메뉴 |
| Properties / Data / 엔티티 관계도 탭 | 세 탭 모두 구현 |
| 결과 CSV · Excel 내보내기 | 데이터 그리드와 SQL 결과에서 CSV / TSV / Excel(.xlsx) 저장. "현재 화면 결과" 또는 "전체 결과(다시 조회)" 선택 |
| DDL 편집 | Properties › 컬럼 에서 컬럼 추가·수정·삭제 → ALTER 문 미리보기 후 실행. DDL 탭도 직접 편집·실행 가능 |
| 실행 계획 | SQL 편집기의 `실행 계획` 버튼. 비용 막대가 있는 트리 / 원본 / JSON 3가지 보기. ANALYZE 체크 시 실측값 |
| 쿼리 히스토리 | 실행한 모든 문장을 기록. 검색·오류만·현재 접속만 필터, 더블클릭으로 편집기에서 열기, CSV 내보내기 |

### 객체 검색

좌측 검색창은 두 가지로 동작한다.

- **이름만 켜져 있으면** 타이핑하는 대로 트리를 걸러 낸다. 데이터베이스·스키마·테이블 어느 계층이든
  이름이 맞으면 남고, 이미 펼쳐 둔 하위 항목이 맞아도 남는다.
  아직 펼치지 않아 안을 모르는 곳은 (맞는 게 하나도 없을 때만) 남겨 둬서 들어가 볼 수 있게 한다.
- **컬럼명·주석·스크립트 중 하나라도 켜면** `Enter` 로 DB 에 직접 질의한다.
  펼치지 않은 스키마까지 한 번에 훑을 수 있고, `모든 스키마` 를 켜면 접속 전체가 대상이 된다.

| 범위 | 찾는 것 |
| --- | --- |
| 이름 | 테이블·뷰 이름 |
| 컬럼명 | 컬럼 이름 |
| 주석 | 테이블·컬럼 주석 |
| 스크립트 | 뷰 정의, 함수·프로시저 본문, 트리거 정의 |

결과를 더블클릭하면 테이블은 탭으로(컬럼이 걸린 경우 Properties 로), 함수·프로시저·트리거는
정의를 조회하는 SQL 이 편집기에 열린다.

> MySQL·MariaDB 는 프로시저·함수 본문을 저장할 때 주석을 모두 지운다 (`SHOW CREATE PROCEDURE` 에도 남지 않는다).
> 따라서 루틴 **안의 주석**은 검색되지 않고 SQL 코드만 검색된다. PostgreSQL 은 원본이 그대로 남아 주석까지 찾는다.

### Data 탭

- 페이지 단위 조회(100/200/500/1000행), 이전/다음, `행 수 세기`
- 셀을 한 번 클릭하면 선택, 두 번 클릭하면 편집이다
- **행을 선택하고 `Tab`** 을 누르면 그 행이 세로로 펼쳐진다 (DBeaver 의 Record 모드).
  컬럼이 많아 가로 스크롤이 길 때 값을 확인·수정하기 편하다.
  세로 보기에서도 값을 더블클릭해 고칠 수 있고, `↑` `↓` 로 행을 옮기며, `Tab` 으로 그리드에 돌아온다.
  SQL 편집기 결과 그리드에서도 똑같이 쓸 수 있다.
- 컬럼 헤더 클릭으로 정렬(오름차순 → 내림차순 → 해제)
- `필터` 입력란에 WHERE 절 조각을 넣어 조건 조회
- 셀 더블클릭으로 편집, `+ 행 추가` / `− 행 삭제 표시` 후 `변경 저장`
  - 변경분은 UPDATE / INSERT / DELETE 로 변환되어 하나의 트랜잭션으로 적용된다
  - 수동 커밋 모드에서는 커밋 전까지 확정되지 않는다
  - 기본키가 없는 테이블과 뷰는 편집할 수 없다 (DBeaver 와 동일)
  - 빈 값으로 저장하면 NULL 로 들어간다

### 엔티티 관계도

현재 테이블을 가운데 두고, 외래키로 참조하는 테이블과 이 테이블을 참조하는 테이블을 함께 그린다.
박스는 드래그로 옮길 수 있고 확대/축소와 배치 초기화를 지원한다.

### 내보내기

- **CSV / TSV** — RFC 4180 인용 규칙, UTF-8 BOM 을 붙여 Excel 에서 한글이 깨지지 않는다. NULL 은 빈 칸.
- **Excel (.xlsx)** — 첫 행 고정 + 자동 필터, 숫자로 읽히는 값은 숫자 셀로 넣는다.
- **현재 화면 결과** 는 지금 그리드에 있는 행만, **전체 결과** 는 페이지 제한 없이 다시 조회해서 저장한다
  (안전장치로 100만 행 상한이 있고, 잘리면 알려준다).

### DDL 편집

Properties › 컬럼 에서 `컬럼 편집` 을 누르면 이름 · 타입 · NULL · 기본값 · 주석을 고칠 수 있고,
컬럼을 추가하거나 삭제 표시할 수 있다. `변경 SQL 보기` 를 누르면 생성된 ALTER 문을 먼저 확인한 뒤 실행한다.

- MySQL/MariaDB 는 `CHANGE COLUMN` 한 문장으로, PostgreSQL 은 `RENAME` / `ALTER COLUMN TYPE` /
  `SET·DROP NOT NULL` / `SET·DROP DEFAULT` / `COMMENT ON COLUMN` 으로 나눠 생성한다.
- PostgreSQL 은 하나라도 실패하면 전체가 되돌아간다. MySQL·MariaDB 는 DDL 이 즉시 확정되므로
  중간에 실패하면 앞서 실행된 문장은 그대로 남는다 (미리보기 창에서 알려 준다).
- DDL 탭 자체도 편집기라서, 표시된 DDL 을 고쳐 바로 실행하거나 SQL 편집기로 보낼 수 있다.

기본값은 SQL 식 그대로 입력한다 (`'A'`, `0`, `now()`).

### 실행 계획

`실행 계획` 버튼(⌘/Ctrl + ⇧ + E)은 커서 위치의 문장에 대해 계획을 가져온다.

- PostgreSQL — `EXPLAIN (FORMAT JSON)`, ANALYZE 켜면 `(ANALYZE, BUFFERS)`
- MariaDB — `EXPLAIN FORMAT=JSON`, ANALYZE 켜면 `ANALYZE FORMAT=JSON`
- MySQL 8 — ANALYZE 켜면 `EXPLAIN ANALYZE` (텍스트만 제공)

트리 보기에서는 노드별 비용이 배경 막대 길이로 보이고, 예상 행 수와 실제 행 수가 10배 이상
어긋나거나 인덱스를 타지 못하는 접근(`ALL`)은 노란색으로 표시된다.

### 쿼리 구분

여러 문장을 무엇으로 나눌지 SQL 편집기 툴바의 `구분` 에서 고른다. 선택은 설정 파일에 남아 다음 실행에도 유지된다.

| 선택 | 동작 |
| --- | --- |
| 세미콜론 | `;` 로만 나눈다 (기본) |
| 세미콜론 + 빈 줄 | `;` 에 더해 빈 줄도 문장 경계로 본다 |

문자열 리터럴, 라인·블록 주석, PostgreSQL 달러 인용 안에 있는 `;` 와 빈 줄은 경계로 보지 않는다.
주석과 공백만 남는 조각은 실행 대상에서 빠진다 (그대로 보내면 MySQL 이 "Query was empty" 로 실패한다).

이 설정은 `스크립트 실행` 뿐 아니라 `커서 위치 문장 실행` 과 `실행 계획` 에도 함께 적용된다.

### 탭 관리

탭을 우클릭하면 나오는 메뉴다.

- 닫기
- 오른쪽 탭 닫기 — 그 탭보다 오른쪽에 있는 탭만
- 다른 탭 모두 닫기 — 그 탭만 남긴다
- 탭 모두 닫기

작성한 내용이 있는 SQL 편집기가 닫히려 하면 어떤 편집기인지 이름을 보여 주고 한 번 확인한다.

### SQL 편집기 목록

툴바의 `목록` (⌘/Ctrl + ⇧ + L) 을 누르면 열려 있는 SQL 편집기를 한눈에 볼 수 있다.
편집기마다 접속·DB 와 작성한 SQL 미리보기가 보이고, 내용이 있으면 `작성됨` 표시가 붙는다.

- 클릭 — 그 편집기로 이동
- 더블클릭 또는 ✎ — 이름 변경 (탭 제목도 함께 바뀐다)
- × — 삭제. 작성한 내용이 있으면 한 번 더 확인한다
- `모두 닫기` — 전부 삭제 (내용이 있는 편집기 개수를 알려 준다)

편집기 내용은 앱을 켜 둔 동안만 유지된다. 재시작해도 남기려면 별도 저장 기능이 필요하다(아래 "아직 없는 것").

### 트랜잭션 변경 내역

수동 커밋 모드에서 변경 문장을 실행하면 상태 표시줄에 `수동 커밋 · 트랜잭션 진행 중 (n건)` 이 뜬다.
이 문구를 누르면 아직 확정하지 않은 변경 문장이 탭으로 열린다 — 종류(INSERT/UPDATE/…), 영향 행 수,
출처(SQL 편집기 / 데이터 편집 / DDL), 시각, 실행한 SQL 을 순서대로 보여 주고 거기서 바로 커밋·롤백할 수 있다.

`(n건)` 은 **조회를 제외한 변경 문장 수**다. SELECT 만 실행해 트랜잭션이 열린 경우 0건으로 표시된다.

커밋·롤백을 누르면 무엇이 확정·취소되는지 목록으로 보여 주는 확인창이 먼저 뜬다.
`SQL 복사` 로 그 문장들을 그대로 가져갈 수 있다.

> **MySQL·MariaDB 주의** — 이 DB 들은 DDL(`CREATE`/`ALTER`/`DROP`/`TRUNCATE` …)을 실행하면
> **그 앞의 변경까지 함께 암묵적으로 커밋**한다. 그런 문장은 목록에서 `확정됨` 으로 표시되고,
> 롤백 확인창에서도 되돌아가지 않는다고 알려 준다. PostgreSQL 은 DDL 도 트랜잭션 안에서 되돌아간다.

### 쿼리 히스토리

SQL 편집기 실행, 데이터 조회, 그리드 편집, DDL, 실행 계획, 내보내기 조회를 모두 기록한다.
`userData/query-history.json` 에 최근 5000건까지 남고, 실행마다 쓰지 않고 모았다가 저장한다.

## 단축키

| 키 | 동작 |
| --- | --- |
| ⌘/Ctrl + N | 새 SQL 편집기 |
| ⌘/Ctrl + ⇧ + N | 새 접속 |
| ⌘/Ctrl + Enter | 커서 위치 문장 실행 (선택 영역이 있으면 그 부분) |
| ⌘/Ctrl + ⇧ + Enter | 스크립트 전체 실행 |
| ⌘/Ctrl + ⌥ + C / R | 커밋 / 롤백 |
| ⌘/Ctrl + ⇧ + E | 실행 계획 |
| ⌘/Ctrl + ⇧ + H | 쿼리 히스토리 |
| ⌘/Ctrl + ⇧ + L | SQL 편집기 목록 |
| Tab | 데이터 그리드 ⇄ 세로(레코드) 보기 |
| F5 | 현재 편집기 새로 고침 |

## 패키징 · 배포

### 새 버전 내보내기

버전을 올리고 태그를 밀면 GitHub Actions 가 3개 OS 설치파일을 만들어 Releases 에 올린다.

```bash
npm version 0.2.0        # package.json 버전 변경 + v0.2.0 태그 생성
git push && git push --tags
```

Actions 탭의 **Release** 워크플로에서 진행 상황을 볼 수 있고, 끝나면 Releases 에 파일이 붙는다.
태그 없이 시험해 보려면 Actions 탭에서 `Run workflow` 로 태그 이름을 직접 넣어 돌린다.

macOS 용은 macOS 러너에서만, Windows 용은 Windows 러너에서만 만들 수 있어서 세 OS 가 각각 빌드한다.

### 로컬에서 빌드

```bash
npm run icons   # build/icon.png 생성 (한 번만, 외부 이미지 도구 없이 PNG 를 직접 씀)
npm run pack    # 서명 없이 앱 폴더만 만들기 (release/mac-arm64/DB Studio.app)
npm run dist    # 현재 플랫폼용 설치 파일
```

플랫폼별로는 `npm run dist:mac` / `dist:win` / `dist:linux` 를 쓴다.
macOS 는 dmg + zip (arm64, x64), Windows 는 NSIS 설치 파일, Linux 는 AppImage + deb 를 만든다.

`mysql2` / `pg` / `exceljs` 는 asar 밖으로 빼서(`asarUnpack`) 패키징된 앱에서도 그대로 로드된다.

### 코드 서명

지금은 서명하지 않는다 (워크플로에서 `CSC_IDENTITY_AUTO_DISCOVERY=false`).
서명하려면 저장소 시크릿에 인증서를 넣고 `.github/workflows/release.yml` 의 해당 줄을 지운다.

| 시크릿 | 내용 |
| --- | --- |
| `CSC_LINK` | macOS `.p12` 인증서를 base64 로 인코딩한 값 |
| `CSC_KEY_PASSWORD` | 인증서 비밀번호 |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows 코드 서명 인증서 |

macOS 공증(notarization)까지 하려면 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 를
추가하고 `build.mac.notarize` 를 켠다.

## 구조

```
electron/
  main.js          창 생성, 메뉴, IPC 핸들러
  preload.js       contextBridge 로 window.api 노출
  store.js         접속 정보 저장 (userData/connections.json, 비밀번호는 safeStorage 암호화)
  history.js       쿼리 히스토리 기록·조회 (userData/query-history.json)
  settings.js      화면 설정 저장 (userData/settings.json)
  export.js        CSV / TSV / Excel 저장
  db/
    index.js       세션·트랜잭션 관리, 데이터 조회/변경, 스크립트 실행, 실행 계획, DDL, 객체 검색
    searchutil.js  LIKE 이스케이프와 검색어 주변 스니펫
    mysql.js       MySQL / MariaDB 드라이버
    postgres.js    PostgreSQL 드라이버
    sqlparse.js    SQL 문장 분리 (문자열·주석·달러 인용 인식)
mcp/
  server.js        Claude Code 용 MCP 서버 (electron/db 를 그대로 재사용)
  config.js        MCP 전용 접속 설정 읽기
  init.js          설정 파일 예시 생성
scripts/
  make-icon.js     build/icon.png 생성
  install-app.js   빌드한 앱을 ~/Applications 에 설치 (번들을 유지해 Dock 고정을 지킨다)
src/
  state/           전역 스토어와 액션
  components/      UI (ContextMenu 는 트리·탭이 함께 쓰는 우클릭 메뉴)
  lib/sqlparse.ts  렌더러용 문장 분리 (커서 위치 문장 실행에 필요)
  lib/plan.ts      실행 계획 JSON 을 공통 트리로 정규화
```

DB 접근은 전부 메인 프로세스에서 일어나고, 렌더러는 `contextIsolation` 아래에서 IPC 로만 통신한다.
접속마다 전용 커넥션 하나를 유지하므로 트랜잭션이 SQL 편집기와 데이터 그리드에 걸쳐 이어진다.

## Claude Code 연결 (MCP)

DB Studio 의 드라이버와 메타데이터 조회 로직을 MCP 서버로 내어, Claude Code 가 데이터베이스를
직접 살펴볼 수 있다. **Claude Code 구독을 그대로 쓰므로 추가 과금이 없다** (Anthropic API 키가 필요하지 않다).

```bash
npm run mcp:init          # ~/.dbstudio-mcp.json 예시 생성 (권한 600)
# 접속 정보를 채운 뒤 등록
claude mcp add dbstudio -s user -- "$(which node)" <저장소경로>/mcp/server.js
```

등록한 뒤 `claude` 를 새로 띄우면 붙는다 (MCP 는 세션 시작 시 로드된다). `/mcp` 로 상태를 볼 수 있다.

> **node 경로를 절대 경로로 넣는다.** nvm 을 쓰면 기본 버전이 낮게 잡혀 있을 수 있고,
> 이 서버는 Node 18 이상이 필요하다. `node` 라고만 적으면 실행 시점의 버전에 따라 실패한다.
> (낮은 버전으로 뜨면 서버가 무엇이 문제인지 알려주고 종료한다.)

> Claude Code 세션 **안에서** `claude mcp add` 를 실행하면, 실행 중인 클라이언트가
> `~/.claude.json` 을 다시 쓰면서 등록이 지워질 수 있다. 별도 터미널에서 실행하고
> `claude mcp list` 로 남았는지 확인한다.

앱과 무관하게 독립 실행된다 — DB Studio 를 켜 두지 않아도 된다.
앱의 접속 정보는 OS 키체인으로 암호화돼 있어 앱 밖에서 풀 수 없으므로, MCP 서버는 자기 설정 파일을 따로 읽는다.

### 설정 파일

```json
{
  "maxRows": 200,
  "connections": [
    {
      "name": "prod-emr",
      "kind": "postgres",
      "host": "10.0.0.10",
      "port": 5432,
      "user": "readonly",
      "passwordEnv": "EMR_PASSWORD",
      "database": "emr",
      "readOnly": true
    }
  ]
}
```

- `passwordEnv` 로 환경변수 이름을 가리키면 비밀번호를 파일에 적지 않아도 된다. `password` 로 직접 적어도 된다.
- `maxRows` 는 한 번에 돌려줄 행 수 상한이다 (기본 200, 최대 10000).
- 설정 파일 위치는 `DBSTUDIO_MCP_CONFIG` 로 바꿀 수 있다.

### 도구

| 도구 | 하는 일 |
| --- | --- |
| `list_connections` | 등록된 접속과 조회 전용 여부 |
| `list_schemas` | 데이터베이스·스키마 목록 |
| `list_tables` | 테이블·뷰 목록 (주석, 대략적인 행 수) |
| `describe_table` | 컬럼·키·외래키·참조·인덱스·DDL 을 한 번에 |
| `query` | 조회 실행 (행 수 상한 적용) |
| `search_objects` | 이름·컬럼명·주석·정의 스크립트 검색 |
| `explain` | 실행 계획 (쿼리를 실행하지 않는다) |
| `commit` | 쓰기 접속의 트랜잭션 확정·롤백 |

### 안전장치

에이전트가 실수로 데이터를 바꾸지 못하게 기본값을 좁게 잡았다.

- **접속은 기본이 조회 전용이다.** `"readOnly": false` 를 명시해야 쓰기가 열린다.
- 조회 전용 접속에서는 **SELECT 계열 한 문장만** 통과한다. `UPDATE`·`DROP`·여러 문장은 거부된다.
- 결과 행 수에 상한이 있어 큰 테이블을 통째로 끌어오지 않는다.
- 쓰기가 열린 접속도 **수동 커밋이 기본**이라 `commit` 을 부르기 전에는 확정되지 않는다.
  `commit` 은 무엇이 확정되는지 문장 목록으로 함께 돌려준다.

> 운영 DB 를 붙일 때는 **읽기 전용 DB 계정**을 만들어 쓰는 편이 안전하다.
> 설정 파일의 `readOnly` 는 이 서버가 거는 제약이고, DB 권한 자체가 아니다.
> 설정 파일에 비밀번호를 평문으로 두게 되므로(권한 600) `passwordEnv` 쪽을 권한다.

## 설정 파일 위치

접속 정보와 쿼리 히스토리는 OS 사용자 폴더에 저장된다. 앱 이름을 `DB Studio` 로 고정해 두었으므로
**소스로 실행하든 설치본으로 실행하든 같은 설정을 쓴다.**

| OS | 경로 |
| --- | --- |
| macOS | `~/Library/Application Support/DB Studio/` |
| Windows | `%APPDATA%\DB Studio\` |
| Linux | `~/.config/DB Studio/` |

이 폴더에는 접속 정보(`connections.json`), 쿼리 히스토리(`query-history.json`),
화면 설정(`settings.json` — 쿼리 구분 방식 등)이 들어간다.

예전 소스 실행은 `dbstudio` 폴더를 썼다. 처음 실행할 때 `connections.json` 과 `query-history.json` 을
새 폴더로 한 번 복사해 온다 (원본은 그대로 남는다).

비밀번호는 OS 키체인으로 암호화되어 있어 파일만 복사해도 다른 사용자 계정에서는 풀리지 않는다.

## 아이콘

`build/icon.png` (1024×1024) 하나로 모든 플랫폼 아이콘을 만든다.

- **설치본** — electron-builder 가 `icon.icns` / `icon.ico` 로 변환해 번들에 넣는다.
- **소스 실행** — 번들 아이콘이 없어 Electron 기본 아이콘이 뜨므로,
  `main.js` 가 macOS 는 `app.dock.setIcon()`, Windows·Linux 는 창의 `icon` 옵션으로 직접 지정한다.

아이콘을 바꾸려면 `scripts/make-icon.js` 를 고치고 `npm run icons` 를 실행한다.
직접 만든 PNG 로 갈아 끼워도 된다 (1024×1024 권장).

`build/icon.png` 은 `npm run icons` 를 실행할 때만 만들어진다. 일반 빌드는 이 파일을 건드리지 않고,
electron-builder 가 이걸로 `icon.icns` 를 만들 뿐이다 (내용이 같으면 결과도 같다).

## 아직 없는 것

- Oracle / SQL Server 드라이버 (`electron/db/` 에 드라이버를 추가하고 `DRIVERS` 에 등록하면 된다)
- CSV/Excel 가져오기 (내보내기만 있음)
- SQL 편집기 내용의 영구 저장 (앱을 재시작하면 사라진다)
- 인덱스·제약조건 편집 (컬럼 편집만 있음), 테이블 생성·삭제
- 큰 결과의 스트리밍 내보내기 (지금은 전부 메모리에 올린 뒤 저장한다)
- macOS 코드 서명 · 공증, 자동 업데이트
- 앱 안의 AI 어시스턴트 (자연어→SQL). Claude API 키가 필요해 별도 과금이 붙는다 — 지금은 MCP 쪽만 있다
