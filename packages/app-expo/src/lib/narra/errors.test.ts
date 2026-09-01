import { describe, expect, it } from "vitest";
import {
  NarraServiceError,
  isNarraTimeoutError,
  narraErrorFromGatewayResponse,
  normalizeNarraError,
} from "./errors";

describe("Narra error messages", () => {
  it("separates book extraction failures from generic service failures", () => {
    expect(
      normalizeNarraError(new Error("TypeError: Load failed while extracting a book text sample")),
    ).toMatchObject({
      code: "REQUEST",
      message: "Не удалось прочитать текст книги. Попробуйте снова.",
    });
  });

  it("explains when the character response cannot be used", () => {
    expect(
      normalizeNarraError(new Error("Narra found no characters in the response")),
    ).toMatchObject({
      code: "SERVICE",
      message: "Сервис не распознал персонажей в ответе. Попробуйте снова.",
    });
  });

  it("explains a provider safety rejection", () => {
    expect(
      normalizeNarraError(
        new Error("Kandinsky: запрос или результат отклонён политикой безопасности"),
      ),
    ).toMatchObject({
      code: "SERVICE",
      message: "Сервис отклонил эту сцену по правилам безопасности. Попробуйте другую страницу.",
    });
  });
});

describe("Narra gateway error propagation", () => {
  it("keeps the backend code, status and request id of a rate-limited response", () => {
    const error = narraErrorFromGatewayResponse({
      status: 429,
      payload: { code: "RATE", error: "Попробуйте позже", request_id: "req-42" },
    });

    expect(error).toBeInstanceOf(NarraServiceError);
    expect(error.code).toBe("RATE");
    expect(error.backendCode).toBe("RATE");
    expect(error.requestId).toBe("req-42");
    expect(error.message).toBe("Слишком много запросов. Попробуйте немного позже.");
    expect(error.technicalDetail).toBe("RATE 429: Попробуйте позже");
  });

  it("classifies by status when the body has no machine code", () => {
    expect(narraErrorFromGatewayResponse({ status: 401, bodyText: "nope" }).code).toBe("AUTH");
    expect(narraErrorFromGatewayResponse({ status: 422, payload: {} }).code).toBe("REQUEST");
    expect(narraErrorFromGatewayResponse({ status: 504, payload: {} }).code).toBe("TIMEOUT");
    expect(narraErrorFromGatewayResponse({ status: 500, payload: {} })).toMatchObject({
      code: "SERVICE",
      technicalDetail: "HTTP 500: HTTP 500",
    });
  });

  it("does not misclassify Russian text that merely mentions auth or limits", () => {
    const error = narraErrorFromGatewayResponse({
      status: 503,
      payload: { code: "UPSTREAM", error: "Провайдер временно недоступен, лимит очереди" },
      requestId: "header-id",
    });

    expect(error.code).toBe("SERVICE");
    expect(error.requestId).toBe("header-id");
    expect(error.backendCode).toBe("UPSTREAM");
  });

  it("recognises a timeout anywhere in the cause chain", () => {
    const timeout = new NarraServiceError("TIMEOUT", "slow");
    const wrapped = new Error("Connection error.", { cause: timeout });
    expect(isNarraTimeoutError(wrapped)).toBe(true);
    expect(isNarraTimeoutError(new Error("Connection error."))).toBe(false);
    expect(isNarraTimeoutError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(
      true,
    );
  });
});
