import { Component, type ReactNode } from 'react';

/**
 * Filet de sécurité : si un écran plante pendant son affichage, on montre un message et un bouton pour
 * recharger, au lieu d'un écran noir. Les données ne sont pas touchées (elles restent sur l'appareil).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page center" style={{ padding: 24 }}>
        <h2>Oups, cet écran a rencontré un problème</h2>
        <p className="muted">Vos données sont intactes sur cet appareil. Rechargez l'appli pour continuer.</p>
        <p className="muted small">{String(this.state.error.message ?? this.state.error).slice(0, 200)}</p>
        <button
          className="btn primary"
          onClick={() => {
            location.hash = '#/';
            location.reload();
          }}
        >
          Recharger
        </button>
      </div>
    );
  }
}
