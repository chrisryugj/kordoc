package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.ObjectMapper;

/** 공용 Jackson ObjectMapper — 결과 JSON 은 트리(JsonNode)로 받아 알 수 없는 필드도 보존한다 */
final class Json {
    static final ObjectMapper MAPPER = new ObjectMapper();

    private Json() {}
}
