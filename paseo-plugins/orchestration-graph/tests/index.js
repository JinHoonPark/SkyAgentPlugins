// node --test tests/가 디렉터리의 모든 테스트를 실행하는 진입점.
Promise.all([import("./graph-curves.test.mjs"), import("./graph-zoom.test.mjs")]);
