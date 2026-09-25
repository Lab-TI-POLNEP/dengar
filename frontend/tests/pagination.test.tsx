import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Pagination, { getPaginationRange } from "../components/Pagination";

describe("getPaginationRange", () => {
  it("returns all pages when totalPages <= 7", () => {
    expect(getPaginationRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(getPaginationRange(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("truncates with dots at end when current page is near start", () => {
    expect(getPaginationRange(2, 10)).toEqual([1, 2, 3, 4, 5, "dots", 10]);
    expect(getPaginationRange(4, 10)).toEqual([1, 2, 3, 4, 5, "dots", 10]);
  });

  it("truncates with dots at start when current page is near end", () => {
    expect(getPaginationRange(9, 10)).toEqual([1, "dots", 6, 7, 8, 9, 10]);
    expect(getPaginationRange(7, 10)).toEqual([1, "dots", 6, 7, 8, 9, 10]);
  });

  it("truncates both sides when current page is in middle", () => {
    expect(getPaginationRange(5, 10)).toEqual([1, "dots", 4, 5, 6, "dots", 10]);
  });
});

describe("Pagination component", () => {
  it("renders active page pill with aria-current", () => {
    render(
      <Pagination
        currentPage={2}
        totalPages={5}
        totalItems={25}
        pageSize={5}
        onPageChange={vi.fn()}
      />
    );

    const page2Btn = screen.getByRole("button", { name: "Page 2" });
    expect(page2Btn).toHaveAttribute("aria-current", "page");
    expect(page2Btn.className).toContain("is-active");
    expect(page2Btn.className).toContain("pagination__btn--active");

    const page1Btn = screen.getByRole("button", { name: "Page 1" });
    expect(page1Btn).not.toHaveAttribute("aria-current");
    expect(page1Btn.className).not.toContain("pagination__btn--active");
  });

  it("renders ellipsis dots when total pages exceeds threshold", () => {
    render(
      <Pagination
        currentPage={1}
        totalPages={10}
        totalItems={50}
        pageSize={5}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("calls onPageChange when page numbers, next, and previous are clicked", () => {
    const handlePageChange = vi.fn();
    render(
      <Pagination
        currentPage={2}
        totalPages={4}
        totalItems={20}
        pageSize={5}
        onPageChange={handlePageChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(handlePageChange).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(handlePageChange).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(handlePageChange).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    expect(handlePageChange).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(handlePageChange).toHaveBeenCalledWith(4);
  });

  it("disables Previous and First buttons on page 1", () => {
    render(
      <Pagination
        currentPage={1}
        totalPages={3}
        totalItems={15}
        pageSize={5}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Last page" })).toBeEnabled();
  });

  it("disables Next and Last buttons on last page", () => {
    render(
      <Pagination
        currentPage={3}
        totalPages={3}
        totalItems={15}
        pageSize={5}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "First page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Last page" })).toBeDisabled();
  });

  it("displays formatted item range summary", () => {
    render(
      <Pagination
        currentPage={2}
        totalPages={3}
        totalItems={14}
        pageSize={5}
        itemLabel="assets"
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
  });

  it("triggers onPageSizeChange when rows-per-page is selected", () => {
    const handleSizeChange = vi.fn();
    render(
      <Pagination
        currentPage={1}
        totalPages={3}
        totalItems={14}
        pageSize={5}
        pageSizeOptions={[5, 10, 20]}
        onPageChange={vi.fn()}
        onPageSizeChange={handleSizeChange}
      />
    );

    const select = screen.getByLabelText("Items per page");
    fireEvent.change(select, { target: { value: "10" } });
    expect(handleSizeChange).toHaveBeenCalledWith(10);
  });

  it("allows jumping to a page using the jumper form", () => {
    const handlePageChange = vi.fn();
    render(
      <Pagination
        currentPage={1}
        totalPages={10}
        totalItems={100}
        pageSize={10}
        showPageJumper={true}
        onPageChange={handlePageChange}
      />
    );

    const jumpInput = screen.getByLabelText("Jump to page");
    fireEvent.change(jumpInput, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(handlePageChange).toHaveBeenCalledWith(7);
  });
});

