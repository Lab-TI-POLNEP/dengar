import { render, screen } from "@testing-library/react";
import Home from "../app/page";

describe("Landing page", () => {
  it("renders hero and sections", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { name: /Dengar/i })).toBeInTheDocument();
    expect(screen.getByText(/subjective speech evaluation/i)).toBeInTheDocument();
    const startLinks = screen.getAllByRole("link", { name: /Get started/i });
    expect(startLinks.length).toBe(2);
    startLinks.forEach((link) => {
      expect(link).toHaveAttribute("href", "/get-started");
    });
    expect(screen.getByText(/what to expect/i)).toBeInTheDocument();
    expect(screen.getByText(/headphones recommended/i)).toBeInTheDocument();
    expect(screen.getByText(/duration/i)).toBeInTheDocument();
    expect(screen.getByText(/Confidentiality/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
