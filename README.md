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

## 구현된 기능

| 요구사항 | 구현 |
| --- | --- |
| DB 연결 | 접속 정보 저장/편집/삭제, 연결 테스트, 비밀번호는 OS 키체인(`safeStorage`)으로 암호화 저장. 저장하지 않으면 접속 시 입력받는다. 여러 접속을 동시에 열 수 있다. |
| 테이블 조회 및 검색 | 좌측 트리 상단 검색창에서 테이블·뷰 이름을 즉시 필터링 |
| 테이블 컬럼 및 데이터 확인 | Properties 탭(컬럼/키/외래키/참조/인덱스/DDL) 과 Data 탭(그리드) |
| SQL 편집기 | CodeMirror 6 기반. DB 종류에 맞는 문법 강조·자동완성, 커서 위치 문장 실행(⌘/Ctrl+Enter), 스크립트 전체 실행(⌘/Ctrl+⇧+Enter), 문장별 결과 탭 |
| 커밋 / 롤백 | 자동/수동 커밋 전환, 수동 모드에서 첫 문장 실행 시 트랜잭션 시작, 커밋 버튼에 미확정 문장 수 표시, 상태 표시줄에 트랜잭션 상태 노출 |
| 스키마 드롭다운 | 상단 툴바의 DB / 스키마 드롭다운. 선택 시 실제로 전환된다 (MySQL `USE`, PostgreSQL `SET search_path`) |
| 위치 정보 노출 | 편집기 상단 브레드크럼 `접속 › DB › 스키마 › 테이블` |
| 테이블 탭 구분 | 열린 객체마다 탭 생성, 탭 선택 시 화면 전환, 가운데 클릭으로 닫기 |
| 좌측 트리그리드 | `접속 › DB › 스키마 › 테이블` (MySQL 은 DB=스키마이므로 스키마 계층 생략), 우클릭 컨텍스트 메뉴 |
| Properties / Data / 엔티티 관계도 탭 | 세 탭 모두 구현 |
| 결과 CSV · Excel 내보내기 | 데이터 그리드와 SQL 결과에서 CSV / TSV / Excel(.xlsx) 저장. "현재 화면 결과" 또는 "전체 결과(다시 조회)" 선택 |
| DDL 편집 | Properties › 컬럼 에서 컬럼 추가·수정·삭제 → ALTER 문 미리보기 후 실행. DDL 탭도 직접 편집·실행 가능 |
| 실행 계획 | SQL 편집기의 `실행 계획` 버튼. 비용 막대가 있는 트리 / 원본 / JSON 3가지 보기. ANALYZE 체크 시 실측값 |
| 쿼리 히스토리 | 실행한 모든 문장을 기록. 검색·오류만·현재 접속만 필터, 더블클릭으로 편집기에서 열기, CSV 내보내기 |

### Data 탭

- 페이지 단위 조회(100/200/500/1000행), 이전/다음, `행 수 세기`
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
- 하나라도 실패하면 전체가 되돌아간다. 수동 커밋 모드에서는 커밋해야 확정된다.
- DDL 탭 자체도 편집기라서, 표시된 DDL 을 고쳐 바로 실행하거나 SQL 편집기로 보낼 수 있다.

기본값은 SQL 식 그대로 입력한다 (`'A'`, `0`, `now()`).

### 실행 계획

`실행 계획` 버튼(⌘/Ctrl + ⇧ + E)은 커서 위치의 문장에 대해 계획을 가져온다.

- PostgreSQL — `EXPLAIN (FORMAT JSON)`, ANALYZE 켜면 `(ANALYZE, BUFFERS)`
- MariaDB — `EXPLAIN FORMAT=JSON`, ANALYZE 켜면 `ANALYZE FORMAT=JSON`
- MySQL 8 — ANALYZE 켜면 `EXPLAIN ANALYZE` (텍스트만 제공)

트리 보기에서는 노드별 비용이 배경 막대 길이로 보이고, 예상 행 수와 실제 행 수가 10배 이상
어긋나거나 인덱스를 타지 못하는 접근(`ALL`)은 노란색으로 표시된다.

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
  export.js        CSV / TSV / Excel 저장
  db/
    index.js       세션·트랜잭션 관리, 데이터 조회/변경, 스크립트 실행, 실행 계획, DDL
    mysql.js       MySQL / MariaDB 드라이버
    postgres.js    PostgreSQL 드라이버
    sqlparse.js    SQL 문장 분리 (문자열·주석·달러 인용 인식)
scripts/
  make-icon.js     build/icon.png 생성
src/
  state/           전역 스토어와 액션
  components/      UI
  lib/sqlparse.ts  렌더러용 문장 분리 (커서 위치 문장 실행에 필요)
  lib/plan.ts      실행 계획 JSON 을 공통 트리로 정규화
```

DB 접근은 전부 메인 프로세스에서 일어나고, 렌더러는 `contextIsolation` 아래에서 IPC 로만 통신한다.
접속마다 전용 커넥션 하나를 유지하므로 트랜잭션이 SQL 편집기와 데이터 그리드에 걸쳐 이어진다.

## 아직 없는 것

- Oracle / SQL Server 드라이버 (`electron/db/` 에 드라이버를 추가하고 `DRIVERS` 에 등록하면 된다)
- CSV/Excel 가져오기 (내보내기만 있음)
- 인덱스·제약조건 편집 (컬럼 편집만 있음), 테이블 생성·삭제
- 큰 결과의 스트리밍 내보내기 (지금은 전부 메모리에 올린 뒤 저장한다)
- macOS 코드 서명 · 공증, 자동 업데이트
