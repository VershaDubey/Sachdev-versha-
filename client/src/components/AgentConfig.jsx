import React, { useEffect, useState } from 'react';
import {
    Settings,
    ChevronDown,
    ChevronUp,
    Users,
    MessageCircle,
    Shield,
    Zap,
} from 'lucide-react';
import { getSquadAgents } from '../lib/api';

const squadIcons = {
    greeting: '\u{1F44B}',
    qualification: '\u{1F50D}',
    serviceAdvisor: '\u{1F527}',
    booking: '\u{1F4C5}',
    closing: '\u2705',
};

const squadColors = {
    greeting: 'var(--accent-indigo)',
    qualification: 'var(--accent-cyan)',
    serviceAdvisor: 'var(--accent-amber)',
    booking: 'var(--accent-emerald)',
    closing: 'var(--accent-violet)',
};

export default function AgentConfig() {
    const [squads, setSquads] = useState(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(null);

    useEffect(() => {
        loadSquads();
    }, []);

    async function loadSquads() {
        try {
            const res = await getSquadAgents();
            if (res.success) setSquads(res.data);
        } catch (err) {
            console.error('Failed to load squads:', err);
        } finally {
            setLoading(false);
        }
    }

    if (loading) {
        return (
            <div className="animate-fadeIn">
                <div className="page-header"><h1>Loading...</h1></div>
            </div>
        );
    }

    return (
        <div className="animate-fadeIn">
            <div className="page-header">
                <h1>Agent Squad Configuration</h1>
                <p>View and understand the phased support architecture for Godrej appliance support calls</p>
            </div>

            {/* Architecture Overview */}
            <div className="card mb-6">
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
                    <Zap size={18} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />
                    Conversation Flow
                </h2>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    overflowX: 'auto',
                    padding: '12px 0',
                }}>
                    {squads && Object.entries(squads).map(([key, squad], i, arr) => (
                        <React.Fragment key={key}>
                            <div style={{
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-md)',
                                padding: '14px 18px',
                                minWidth: 150,
                                textAlign: 'center',
                                transition: 'all var(--transition-normal)',
                                cursor: 'pointer',
                            }}
                                onClick={() => setExpanded(expanded === key ? null : key)}
                            >
                                <div style={{ fontSize: 24, marginBottom: 6 }}>{squadIcons[key]}</div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: squadColors[key] }}>
                                    {squad.name}
                                </div>
                                <div className="text-sm text-muted" style={{ fontSize: 11, marginTop: 2 }}>
                                    Phase {i + 1}
                                </div>
                            </div>
                            {i < arr.length - 1 && (
                                <div style={{ color: 'var(--text-muted)', fontSize: 20, flexShrink: 0 }}>\u2192</div>
                            )}
                        </React.Fragment>
                    ))}
                </div>
            </div>

            {/* Squad Details */}
            {squads && Object.entries(squads).map(([key, squad]) => (
                <div
                    key={key}
                    className="card mb-4 animate-fadeIn"
                    style={{
                        borderColor: expanded === key ? squadColors[key] : 'var(--border-subtle)',
                        transition: 'border-color var(--transition-normal)',
                    }}
                >
                    <div
                        className="flex items-center justify-between"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpanded(expanded === key ? null : key)}
                    >
                        <div className="flex items-center gap-3">
                            <span style={{ fontSize: 28 }}>{squadIcons[key]}</span>
                            <div>
                                <h2 style={{ fontSize: 16, fontWeight: 700, color: squadColors[key] }}>
                                    {squad.name}
                                </h2>
                                <p className="text-sm text-secondary">{squad.description}</p>
                            </div>
                        </div>
                        {expanded === key ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                    </div>

                    {expanded === key && (
                        <div style={{ marginTop: 20, animation: 'fadeIn 0.3s ease-out' }}>
                            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                                <span className="badge badge-created">
                                    <Shield size={10} /> Guardrailed
                                </span>
                                <span className="badge badge-queued">
                                    <MessageCircle size={10} /> Variable-Driven
                                </span>
                                <span className="badge badge-in-progress">
                                    <Users size={10} /> Multilingual
                                </span>
                            </div>

                            <div style={{
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-md)',
                                padding: 20,
                                maxHeight: 400,
                                overflowY: 'auto',
                            }}>
                                <pre style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 12,
                                    lineHeight: 1.6,
                                    color: 'var(--text-secondary)',
                                    whiteSpace: 'pre-wrap',
                                    wordWrap: 'break-word',
                                }}>
                                    {squad.prompt}
                                </pre>
                            </div>
                        </div>
                    )}
                </div>
            ))}

            {/* Variables Guide */}
            <div className="card mt-6">
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
                    Template Variables
                </h2>
                <p className="text-sm text-secondary mb-4">
                    These variables are automatically injected from your CSV campaign data into every agent prompt.
                </p>
                <div className="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Variable</th>
                                <th>Source</th>
                                <th>Description</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[
                                ['{{customer_name}}', 'CSV \u2192 customer_name', 'Customer full name for personalized greeting'],
                                ['{{phone_number}}', 'CSV \u2192 phone_number', 'Customer phone number (auto-formatted to +91)'],
                                ['{{customer_type}}', 'CSV \u2192 customer_type', 'Whether the caller is a customer or dealer'],
                                ['{{product_category}}', 'CSV \u2192 product_category', 'Appliance category such as AC or refrigerator'],
                                ['{{product_name}}', 'CSV \u2192 product_name', 'Product or appliance name'],
                                ['{{model_number}}', 'CSV \u2192 model_number', 'Product model number'],
                                ['{{serial_number}}', 'CSV \u2192 serial_number', 'Product serial number'],
                                ['{{purchase_date}}', 'CSV \u2192 purchase_date', 'Purchase or invoice date if known'],
                                ['{{warranty_status}}', 'CSV \u2192 warranty_status', 'Known warranty state if available'],
                                ['{{address}}', 'CSV \u2192 address', 'Customer address for service or installation'],
                                ['{{pincode}}', 'CSV \u2192 pincode', 'Customer pincode'],
                                ['{{issue_summary}}', 'CSV \u2192 issue_summary', 'Known short issue description'],
                                ['{{preferred_language}}', 'CSV or Campaign setting', 'Language: hindi, english, or hinglish'],
                                ['{{dealer_name}}', 'Campaign setting', 'Support center or brand support name'],
                                ['{{dealer_address}}', 'Campaign setting', 'Support center address'],
                                ['{{dealer_phone}}', 'Campaign setting', 'Support contact number'],
                            ].map(([variable, source, desc]) => (
                                <tr key={variable}>
                                    <td><code style={{ color: 'var(--accent-indigo)', background: 'rgba(99, 102, 241, 0.1)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{variable}</code></td>
                                    <td className="text-sm text-secondary">{source}</td>
                                    <td className="text-sm">{desc}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
