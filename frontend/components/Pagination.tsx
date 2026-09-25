import { FormEvent, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "./Icons";

export type PaginationProps = {
  currentPage: number;
  totalPages: number;
  totalItems?: number;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  ariaLabel?: string;
  itemLabel?: string;
  showPageJumper?: boolean;
  className?: string;
};

export function getPaginationRange(
  currentPage: number,
  totalPages: number
): (number | "dots")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "dots", totalPages];
  }

  if (currentPage >= totalPages - 3) {
    return [
      1,
      "dots",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }

  return [
    1,
    "dots",
    currentPage - 1,
    currentPage,
    currentPage + 1,
    "dots",
    totalPages,
  ];
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  ariaLabel = "Pagination Navigation",
  itemLabel = "items",
  showPageJumper = false,
  className = "",
}: PaginationProps) {
  const [jumpInput, setJumpInput] = useState("");

  const pageRange = getPaginationRange(currentPage, totalPages);

  const startItem =
    totalItems !== undefined && totalItems > 0
      ? (currentPage - 1) * (pageSize || 1) + 1
      : 0;
  const endItem =
    totalItems !== undefined
      ? Math.min(currentPage * (pageSize || 1), totalItems)
      : 0;

  function handleJumpSubmit(e: FormEvent) {
    e.preventDefault();
    const target = parseInt(jumpInput, 10);
    if (!isNaN(target) && target >= 1 && target <= totalPages) {
      onPageChange(target);
      setJumpInput("");
    }
  }

  return (
    <nav
      className={`pagination ${className}`.trim()}
      aria-label={ariaLabel}
    >
      {totalItems !== undefined && (
        <div className="pagination__summary">
          <span className="pagination__info">
            Showing <strong>{startItem}</strong>–<strong>{endItem}</strong> of{" "}
            <strong>{totalItems}</strong> {itemLabel}
          </span>
          {pageSizeOptions && onPageSizeChange && pageSize && (
            <div className="pagination__page-size">
              <label
                htmlFor="pagination-page-size-select"
                className="pagination__page-size-label"
              >
                Rows:
              </label>
              <select
                id="pagination-page-size-select"
                value={pageSize}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                className="pagination__select"
                aria-label="Items per page"
              >
                {pageSizeOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt} / page
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="pagination__controls">
        {/* First Page */}
        <button
          type="button"
          className="pagination__btn pagination__btn--nav"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(1)}
          aria-label="First page"
          title="First page"
        >
          <ChevronsLeftIcon className="pagination__icon" />
        </button>

        {/* Previous Page */}
        <button
          type="button"
          className="pagination__btn pagination__btn--nav pagination__btn--prev"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeftIcon className="pagination__icon" />
          <span className="pagination__btn-text">Previous</span>
        </button>

        {/* Page Numbers */}
        <div className="pagination__pages" role="group" aria-label="Page numbers">
          {pageRange.map((pageItem, idx) => {
            if (pageItem === "dots") {
              return (
                <span
                  key={`dots-${idx}`}
                  className="pagination__dots"
                  aria-hidden="true"
                >
                  &hellip;
                </span>
              );
            }
            const isActive = pageItem === currentPage;
            return (
              <button
                key={pageItem}
                type="button"
                className={`pagination__btn pagination__btn--page ${
                  isActive ? "pagination__btn--active is-active" : ""
                }`}
                onClick={() => onPageChange(pageItem)}
                aria-current={isActive ? "page" : undefined}
                aria-label={`Page ${pageItem}`}
              >
                {pageItem}
              </button>
            );
          })}
        </div>

        {/* Next Page */}
        <button
          type="button"
          className="pagination__btn pagination__btn--nav pagination__btn--next"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label="Next page"
        >
          <span className="pagination__btn-text">Next</span>
          <ChevronRightIcon className="pagination__icon" />
        </button>

        {/* Last Page */}
        <button
          type="button"
          className="pagination__btn pagination__btn--nav"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(totalPages)}
          aria-label="Last page"
          title="Last page"
        >
          <ChevronsRightIcon className="pagination__icon" />
        </button>
      </div>

      {showPageJumper && totalPages > 3 && (
        <form className="pagination__jumper" onSubmit={handleJumpSubmit}>
          <label
            htmlFor="pagination-jump-input"
            className="pagination__jumper-label"
          >
            Go to:
          </label>
          <input
            id="pagination-jump-input"
            type="number"
            min={1}
            max={totalPages}
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            className="pagination__jumper-input"
            aria-label="Jump to page"
            placeholder={String(currentPage)}
          />
          <button type="submit" className="pagination__jumper-btn">
            Go
          </button>
        </form>
      )}
    </nav>
  );
}

export default Pagination;

