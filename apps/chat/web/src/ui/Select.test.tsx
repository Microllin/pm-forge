import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "./Select";

const OPTIONS = [
  { value: "a", label: "苹果" },
  { value: "b", label: "Banana" },
  { value: "c", label: "樱桃", disabled: true },
  { value: "d", label: "Durian" },
];

function Harness({
  onOuterEscape,
}: {
  onOuterEscape?: () => void;
}): React.JSX.Element {
  const [v, setV] = useState("a");
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onOuterEscape?.();
      }}
    >
      <label className="field">
        水果
        <Select value={v} onChange={setV} options={OPTIONS} />
      </label>
      <output>当前：{v}</output>
    </div>
  );
}

afterEach(cleanup);

describe("Select（平台统一下拉）", () => {
  it("包在 label 里：名字来自 label，点开、点选项生效", async () => {
    render(<Harness />);
    const box = screen.getByRole("combobox", { name: /水果/ });
    expect(box).toHaveTextContent("苹果");
    await userEvent.click(box);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Banana" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText("当前：b")).toBeInTheDocument();
  });

  it("点 label 文字也能打开，且不会一开就关", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("水果"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("键盘：↓ 打开、↓ 跳过禁用项、Enter 选中", async () => {
    render(<Harness />);
    screen.getByRole("combobox").focus();
    await userEvent.keyboard("{ArrowDown}"); // 打开，停在当前项「苹果」
    await userEvent.keyboard("{ArrowDown}{ArrowDown}"); // Banana → 跳过樱桃 → Durian
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("当前：d")).toBeInTheDocument();
  });

  it("敲字母跳到对应项", async () => {
    render(<Harness />);
    screen.getByRole("combobox").focus();
    await userEvent.keyboard("{Enter}b{Enter}");
    expect(screen.getByText("当前：b")).toBeInTheDocument();
  });

  it("Esc 只关下拉，不让外层（对话框）跟着关", async () => {
    const outer = vi.fn();
    render(<Harness onOuterEscape={outer} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    // 关着的时候再按 Esc，就该交给外层了
    await userEvent.keyboard("{Escape}");
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("禁用项点了没反应；整个禁用时打不开", async () => {
    const { rerender } = render(<Harness />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "樱桃" }));
    expect(screen.getByText("当前：a")).toBeInTheDocument();
    rerender(
      <Select
        value="a"
        onChange={() => undefined}
        options={OPTIONS}
        disabled
      />,
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("点外面关闭", async () => {
    render(
      <>
        <Harness />
        <button type="button">外面</button>
      </>,
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("button", { name: "外面" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
